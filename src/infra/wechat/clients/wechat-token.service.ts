import { Injectable, Logger } from '@nestjs/common';
import { MultiLevelCacheService } from '../../cache/multi-level-cache.service';
import {
    WechatApiError,
    WechatConfigurationError,
    type WechatTokenKind,
} from '../wechat.types';
import { WECHAT_WORK_BASE_URL, WechatHttpClient } from './wechat-http.client';

/** Refresh the token this many seconds before WeChat expires it. */
const TOKEN_REFRESH_MARGIN_SECONDS = 300;
const TOKEN_REFRESH_MARGIN_MS = TOKEN_REFRESH_MARGIN_SECONDS * 1000;
/** Never cache a token for less than this, even if WeChat reports a tiny TTL. */
const MIN_TOKEN_TTL_SECONDS = 60;
const DEFAULT_EXPIRES_IN_SECONDS = 7200;

const TOKEN_KEY_PREFIX = 'wechat:token';

export interface WechatMpTokenCredentials {
    appId: string;
    appSecret: string;
}

export interface WechatWorkTokenCredentials {
    corpId: string;
    corpSecret: string;
}

interface WechatTokenResponse {
    access_token?: string;
    expires_in?: number;
    errcode?: number;
    errmsg?: string;
}

interface CachedToken {
    token: string;
    /** Epoch milliseconds at which WeChat considers the token invalid. */
    expiresAt: number;
}

export function wechatTokenKey(kind: WechatTokenKind, id: string): string {
    return `${TOKEN_KEY_PREFIX}:${kind}:${id}`;
}

/**
 * Single source of truth for WeChat access tokens.
 *
 * Tokens are shared across instances through `MultiLevelCacheService`
 * (L1 memory + L2 Redis) and refreshed 5 minutes before expiry. Concurrent
 * requests for the same token are collapsed into one in-flight request.
 */
@Injectable()
export class WechatTokenService {
    private readonly logger = new Logger(WechatTokenService.name);
    private readonly inFlight = new Map<string, Promise<string>>();

    constructor(
        private readonly cache: MultiLevelCacheService,
        private readonly http: WechatHttpClient,
    ) {}

    /** `client_credential` token for mini-program / official account. */
    async getAccessToken(
        credentials: WechatMpTokenCredentials,
    ): Promise<string> {
        this.assertCredential(credentials.appId, 'appId');
        this.assertCredential(credentials.appSecret, 'appSecret');

        return this.resolveToken('mp', credentials.appId, async () => {
            const result = await this.http.getJson<WechatTokenResponse>(
                '/cgi-bin/token',
                {
                    query: {
                        grant_type: 'client_credential',
                        appid: credentials.appId,
                        secret: credentials.appSecret,
                    },
                },
            );

            return this.toAccessToken(result, 'mp');
        });
    }

    /** Enterprise WeChat application token. */
    async getWorkAccessToken(
        credentials: WechatWorkTokenCredentials,
    ): Promise<string> {
        this.assertCredential(credentials.corpId, 'corpId');
        this.assertCredential(credentials.corpSecret, 'corpSecret');

        return this.resolveToken('work', credentials.corpId, async () => {
            const result = await this.http.getJson<WechatTokenResponse>(
                `${WECHAT_WORK_BASE_URL}/cgi-bin/gettoken`,
                {
                    query: {
                        corpid: credentials.corpId,
                        corpsecret: credentials.corpSecret,
                    },
                    platform: 'work',
                },
            );

            return this.toAccessToken(result, 'work');
        });
    }

    /**
     * Drops a cached token. Call after a 40001/42001 response so the next
     * request fetches a fresh one.
     */
    async invalidate(kind: WechatTokenKind, id: string): Promise<void> {
        await this.cache.del(wechatTokenKey(kind, id));
        this.logger.debug(`Invalidated WeChat ${kind} access token for ${id}`);
    }

    private async resolveToken(
        kind: WechatTokenKind,
        id: string,
        loader: () => Promise<{ token: string; expiresIn: number }>,
    ): Promise<string> {
        const key = wechatTokenKey(kind, id);

        const cached = await this.cache.get<CachedToken>(key);
        if (cached && this.isUsable(cached)) {
            return cached.token;
        }

        const existing = this.inFlight.get(key);
        if (existing) return existing;

        const pending = loader()
            .then(async ({ token, expiresIn }) => {
                const ttlSeconds = Math.max(
                    expiresIn - TOKEN_REFRESH_MARGIN_SECONDS,
                    MIN_TOKEN_TTL_SECONDS,
                );

                await this.cache.set(
                    key,
                    {
                        token,
                        expiresAt: Date.now() + expiresIn * 1000,
                    } satisfies CachedToken,
                    ttlSeconds,
                );

                this.logger.debug(
                    `Cached WeChat ${kind} access token for ${id} (ttl ${ttlSeconds}s)`,
                );

                return token;
            })
            .finally(() => {
                this.inFlight.delete(key);
            });

        this.inFlight.set(key, pending);
        return pending;
    }

    private isUsable(cached: CachedToken): boolean {
        if (typeof cached.token !== 'string' || cached.token === '') {
            return false;
        }

        return cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now();
    }

    private toAccessToken(
        result: WechatTokenResponse,
        platform: WechatTokenKind,
    ): { token: string; expiresIn: number } {
        const token = result.access_token;

        if (typeof token !== 'string' || token === '') {
            throw new WechatApiError({
                platform,
                endpoint: 'cgi-bin/token',
                errcode: result.errcode,
                errmsg:
                    result.errmsg ??
                    'WeChat token response is missing access_token',
            });
        }

        const expiresIn =
            typeof result.expires_in === 'number' && result.expires_in > 0
                ? result.expires_in
                : DEFAULT_EXPIRES_IN_SECONDS;

        return { token, expiresIn };
    }

    private assertCredential(value: string, label: string): void {
        if (!value || value.trim() === '') {
            throw new WechatConfigurationError(
                `${label} is required to request a WeChat access token`,
            );
        }
    }
}

/** Credentials for whichever token namespace a sub-package needs. */
export type AccessTokenCredentials =
    | { kind: 'mp'; appId: string; appSecret: string }
    | { kind: 'work'; corpId: string; corpSecret: string };

const fallbackLogger = new Logger('WechatAccessToken');

/**
 * Runs `action` with a cached access token, invalidating and retrying once when
 * WeChat reports the token as expired (40001/42001).
 *
 * Shared by the mini-program, official-account and enterprise WeChat
 * sub-packages so the retry semantics stay identical.
 */
export async function withAccessToken<T>(
    tokens: WechatTokenService,
    credentials: AccessTokenCredentials,
    action: (accessToken: string) => Promise<T>,
    logger?: Logger,
): Promise<T> {
    const loadToken = () =>
        credentials.kind === 'work'
            ? tokens.getWorkAccessToken({
                  corpId: credentials.corpId,
                  corpSecret: credentials.corpSecret,
              })
            : tokens.getAccessToken({
                  appId: credentials.appId,
                  appSecret: credentials.appSecret,
              });

    const accessToken = await loadToken();

    try {
        return await action(accessToken);
    } catch (error) {
        if (!(error instanceof WechatApiError) || !error.isTokenExpired) {
            throw error;
        }

        const id =
            credentials.kind === 'work'
                ? credentials.corpId
                : credentials.appId;

        (logger ?? fallbackLogger).warn(
            `WeChat rejected the ${credentials.kind} access token for ${id}; refreshing and retrying once`,
        );

        await tokens.invalidate(credentials.kind, id);

        return action(await loadToken());
    }
}
