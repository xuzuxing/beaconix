import { Logger } from '@nestjs/common';
import {
    WechatApiError,
    WechatPlatform,
    type WechatApiErrorInit,
} from '../wechat.types';

/** Shared default base URLs for the WeChat open-platform APIs. */
export const WECHAT_MP_BASE_URL = 'https://api.weixin.qq.com';
export const WECHAT_WORK_BASE_URL = 'https://qyapi.weixin.qq.com';
export const WECHAT_PAY_BASE_URL = 'https://api.mch.weixin.qq.com';

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 1000;

/** Query parameters that must never be written to logs. */
const SENSITIVE_QUERY_KEYS = new Set([
    'access_token',
    'secret',
    'appsecret',
    'corpsecret',
    'key',
    'sign',
    'signature',
    'api_key',
    'apiv3_key',
]);

/** Body/JSON keys that must never be written to logs. */
const SENSITIVE_BODY_KEYS = new Set([
    'secret',
    'appsecret',
    'app_secret',
    'corpsecret',
    'key',
    'apikey',
    'api_key',
    'apiv3_key',
    'private_key',
    'privatekey',
    'sign',
    'signature',
    'access_token',
    'token',
    'password',
]);

const REDACTED = '***';

/** Replaces sensitive query values with `***`, keeping the URL readable. */
export function redactUrl(url: string): string {
    try {
        const parsed = new URL(url);
        for (const key of [...parsed.searchParams.keys()]) {
            if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
                parsed.searchParams.set(key, REDACTED);
            }
        }
        return parsed.toString();
    } catch {
        return url;
    }
}

/** Deep-clones a JSON-ish value with sensitive keys replaced by `***`. */
export function redactSecrets(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => redactSecrets(item));
    }

    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(
                ([key, item]) => [
                    key,
                    SENSITIVE_BODY_KEYS.has(key.toLowerCase())
                        ? REDACTED
                        : redactSecrets(item),
                ],
            ),
        );
    }

    return value;
}

export interface WechatHttpClientOptions {
    /** Product the client speaks for; used when normalizing errors. */
    platform: WechatPlatform;
    /** Default base URL; absolute request paths bypass it. */
    baseUrl: string;
    timeoutMs?: number;
    maxRetries?: number;
    logger?: Logger;
}

export interface WechatRequestOptions {
    timeoutMs?: number;
    /**
     * Retry attempts for this call. Defaults to the client setting for GET
     * (safe to retry) and 0 for other methods.
     */
    retries?: number;
    headers?: Record<string, string>;
    query?: Record<string, string | number | undefined>;
    /** Overrides the client platform, e.g. a `work` call on the shared client. */
    platform?: WechatPlatform;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * Thin wrapper around the global `fetch` for WeChat APIs.
 *
 * Responsibilities:
 * - build URLs from a base URL (or accept absolute ones)
 * - JSON encode/decode
 * - abort on timeout
 * - retry idempotent requests on network/5xx/429 failures
 * - normalize HTTP + WeChat business errors into `WechatApiError`
 * - keep secrets out of logs
 */
export class WechatHttpClient {
    private readonly logger: Logger;
    private readonly platform: WechatPlatform;
    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private readonly maxRetries: number;

    constructor(options: WechatHttpClientOptions) {
        this.platform = options.platform;
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.logger = options.logger ?? new Logger(WechatHttpClient.name);
    }

    getJson<T>(path: string, options: WechatRequestOptions = {}): Promise<T> {
        return this.request<T>('GET', path, undefined, options);
    }

    postJson<T>(
        path: string,
        body?: unknown,
        options: WechatRequestOptions = {},
    ): Promise<T> {
        return this.request<T>('POST', path, body, options);
    }

    async request<T>(
        method: HttpMethod,
        path: string,
        body?: unknown,
        options: WechatRequestOptions = {},
    ): Promise<T> {
        const url = this.buildUrl(path, options.query);
        const retries =
            options.retries ?? (method === 'GET' ? this.maxRetries : 0);
        const endpoint = `${method} ${redactUrl(url)}`;

        let attempt = 0;

        for (;;) {
            try {
                return await this.send<T>(method, url, body, options);
            } catch (error) {
                const apiError = this.normalizeError(error, endpoint, options);

                if (attempt >= retries || !this.isRetryable(apiError)) {
                    throw apiError;
                }

                attempt += 1;
                const delay = this.backoffMs(attempt);
                this.logger.warn(
                    `Retrying ${endpoint} (${attempt}/${retries}) after ${apiError.message}`,
                );
                await this.sleep(delay);
            }
        }
    }

    /** Builds the request URL; absolute paths are used as-is. */
    private buildUrl(
        path: string,
        query?: Record<string, string | number | undefined>,
    ): string {
        const base = /^https?:\/\//i.test(path)
            ? path
            : `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

        if (!query) return base;

        const url = new URL(base);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }

        return url.toString();
    }

    private async send<T>(
        method: HttpMethod,
        url: string,
        body: unknown,
        options: WechatRequestOptions,
    ): Promise<T> {
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let response: Response;

        try {
            response = await fetch(url, {
                method,
                headers: {
                    accept: 'application/json',
                    ...(body === undefined
                        ? {}
                        : { 'content-type': 'application/json' }),
                    ...options.headers,
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }

        const text = await response.text();
        const payload = this.parseJson(text);
        const platform = options.platform ?? this.platform;

        if (!response.ok) {
            throw this.buildError({
                platform,
                endpoint: `${method} ${redactUrl(url)}`,
                httpStatus: response.status,
                payload,
                fallbackMessage: `HTTP ${response.status}`,
            });
        }

        const businessError = this.extractBusinessError(payload);
        if (businessError) {
            throw this.buildError({
                platform,
                endpoint: `${method} ${redactUrl(url)}`,
                httpStatus: response.status,
                payload,
                fallbackMessage: businessError,
            });
        }

        return payload as T;
    }

    private parseJson(text: string): unknown {
        if (!text) return {};
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    /**
     * WeChat replies `200 + errcode != 0` for business failures (mini-program,
     * official account, enterprise WeChat) and `{ code, message }` for Pay V3.
     */
    private extractBusinessError(payload: unknown): string | null {
        if (payload === null || typeof payload !== 'object') return null;

        const record = payload as Record<string, unknown>;
        const errcode = record.errcode;

        if (typeof errcode === 'number' && errcode !== 0) {
            return `errcode ${errcode}`;
        }

        const code = record.code;
        if (
            typeof code === 'string' &&
            code !== '' &&
            typeof record.message === 'string'
        ) {
            return `code ${code}`;
        }

        return null;
    }

    private buildError(input: {
        platform: WechatPlatform;
        endpoint: string;
        httpStatus?: number;
        payload: unknown;
        fallbackMessage: string;
    }): WechatApiError {
        const record =
            input.payload !== null && typeof input.payload === 'object'
                ? (input.payload as Record<string, unknown>)
                : {};

        const errcode =
            typeof record.errcode === 'number' ? record.errcode : undefined;
        const code = typeof record.code === 'string' ? record.code : undefined;
        const errmsg =
            typeof record.errmsg === 'string'
                ? record.errmsg
                : typeof record.message === 'string'
                  ? record.message
                  : input.fallbackMessage;

        const init: WechatApiErrorInit = {
            platform: input.platform,
            endpoint: input.endpoint,
            httpStatus: input.httpStatus,
            errcode,
            code,
            errmsg,
        };

        return new WechatApiError(init);
    }

    private normalizeError(
        error: unknown,
        endpoint: string,
        options: WechatRequestOptions,
    ): WechatApiError {
        if (error instanceof WechatApiError) return error;

        const platform = options.platform ?? this.platform;
        const isAbort =
            error instanceof Error &&
            (error.name === 'AbortError' || error.name === 'TimeoutError');

        const errmsg = isAbort
            ? `Request timed out after ${options.timeoutMs ?? this.timeoutMs}ms`
            : error instanceof Error
              ? error.message
              : String(error);

        return new WechatApiError({
            platform,
            endpoint,
            errmsg,
            cause: error,
        });
    }

    /** Network failures and 5xx / 429 responses are safe to retry. */
    private isRetryable(error: WechatApiError): boolean {
        if (error.httpStatus === 429) return true;
        if (error.httpStatus !== undefined && error.httpStatus >= 500) {
            return true;
        }

        // Business error (WeChat answered with an errcode/code) is not retried.
        if (error.errcode !== undefined || error.code !== undefined) {
            return false;
        }

        // No HTTP status means the request never completed (DNS/TCP/TLS/timeout).
        return error.httpStatus === undefined;
    }

    private backoffMs(attempt: number): number {
        return Math.min(
            DEFAULT_BACKOFF_MS * 2 ** (attempt - 1),
            MAX_BACKOFF_MS,
        );
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
