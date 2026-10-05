/**
 * Shared types and errors for the WeChat infrastructure layer.
 *
 * The layer is split into four product sub-packages (pay / miniprogram /
 * official-account / work) that all share these primitives.
 */

/** WeChat product a request belongs to. Used for error reporting. */
export type WechatPlatform = 'mp' | 'official-account' | 'work' | 'pay';

/** Token namespace: mini-program/official-account vs enterprise WeChat. */
export type WechatTokenKind = 'mp' | 'work';

export interface WechatApiErrorInit {
    platform: WechatPlatform;
    /** Redacted `METHOD url` of the failing request. */
    endpoint: string;
    httpStatus?: number;
    /** WeChat numeric error code (`errcode` / `code` when numeric). */
    errcode?: number;
    /** WeChat string error code (Pay V3 `code`, e.g. `PARAM_ERROR`). */
    code?: string;
    errmsg?: string;
    cause?: unknown;
}

/**
 * Normalized WeChat API failure, thrown by every sub-package.
 *
 * Callers can branch on `isTokenExpired` / `isRateLimited` instead of
 * matching raw error codes.
 */
export class WechatApiError extends Error {
    readonly platform: WechatPlatform;
    readonly endpoint: string;
    readonly httpStatus?: number;
    readonly errcode?: number;
    readonly code?: string;
    readonly errmsg?: string;

    constructor(init: WechatApiErrorInit) {
        const details: string[] = [];
        if (init.httpStatus !== undefined)
            details.push(`HTTP ${init.httpStatus}`);
        if (init.errcode !== undefined) details.push(`errcode ${init.errcode}`);
        if (init.code !== undefined) details.push(`code ${init.code}`);

        const reason = init.errmsg ?? 'WeChat API request failed';
        super(
            `[${init.platform}] ${init.endpoint}: ${[reason, ...details].join(' ')}`,
        );

        this.name = 'WechatApiError';
        this.platform = init.platform;
        this.endpoint = init.endpoint;
        this.httpStatus = init.httpStatus;
        this.errcode = init.errcode;
        this.code = init.code;
        this.errmsg = init.errmsg;

        if (init.cause !== undefined) {
            this.cause = init.cause;
        }
    }

    /** `access_token` is invalid or expired (40001 / 42001). */
    get isTokenExpired(): boolean {
        return this.errcode === 40001 || this.errcode === 42001;
    }

    /** Too many requests: WeChat frequency limit or HTTP 429. */
    get isRateLimited(): boolean {
        return this.httpStatus === 429 || this.errcode === 45009;
    }
}

/** Missing or malformed WeChat configuration / credentials. */
export class WechatConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WechatConfigurationError';
    }
}
