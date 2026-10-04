import { BadRequestException } from '@nestjs/common';
import { NotificationChannelType } from '../../generated/prisma/enums';
import type { NotificationPayload } from './notifier.types';

export interface FeishuConfig {
    webhookUrl: string;
    secret?: string;
}

export interface WecomConfig {
    webhookUrl: string;
}

export interface DingtalkConfig {
    webhookUrl: string;
    secret?: string;
}

export interface WechatSubscribeConfig {
    appId: string;
    appSecret: string;
    templateId: string;
    openIds: string[];
    page?: string;
    miniprogramState?: 'developer' | 'trial' | 'formal';
    /** template field key -> payload attribute (or literal fallback). */
    fields?: Record<string, string>;
}

export interface EmailConfig {
    to: string[];
}

/** Default WeChat subscribe template fields, keyed by the template's own keys. */
export const DEFAULT_WECHAT_FIELDS: Record<string, string> = {
    thing1: 'monitorName',
    phrase2: 'status',
    time3: 'checkedAt',
};

const HTTP_URL_PATTERN = /^https?:\/\//i;

function asRecord(
    config: unknown,
    channelType: string,
): Record<string, unknown> {
    if (
        config === null ||
        typeof config !== 'object' ||
        Array.isArray(config)
    ) {
        throw new BadRequestException(
            `${channelType} channel config must be a JSON object`,
        );
    }
    return config as Record<string, unknown>;
}

function requireString(
    config: Record<string, unknown>,
    key: string,
    channelType: string,
): string {
    const value = config[key];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new BadRequestException(
            `${channelType} channel config requires a non-empty "${key}"`,
        );
    }
    return value.trim();
}

function optionalString(
    config: Record<string, unknown>,
    key: string,
    channelType: string,
): string | undefined {
    const value = config[key];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') {
        throw new BadRequestException(
            `${channelType} channel config field "${key}" must be a string`,
        );
    }
    return value.trim();
}

function requireUrl(
    config: Record<string, unknown>,
    key: string,
    channelType: string,
): string {
    const value = requireString(config, key, channelType);
    if (!HTTP_URL_PATTERN.test(value)) {
        throw new BadRequestException(
            `${channelType} channel config field "${key}" must be an http(s) URL`,
        );
    }
    return value;
}

function requireStringArray(
    config: Record<string, unknown>,
    key: string,
    channelType: string,
): string[] {
    const value = config[key];

    if (typeof value === 'string' && value.trim() !== '') {
        return [value.trim()];
    }

    if (!Array.isArray(value) || value.length === 0) {
        throw new BadRequestException(
            `${channelType} channel config requires a non-empty "${key}" array`,
        );
    }

    const items = value.map((item) => {
        if (typeof item !== 'string' || item.trim() === '') {
            throw new BadRequestException(
                `${channelType} channel config field "${key}" must contain non-empty strings`,
            );
        }
        return item.trim();
    });

    return items;
}

function optionalStringMap(
    config: Record<string, unknown>,
    key: string,
    channelType: string,
): Record<string, string> | undefined {
    const value = config[key];
    if (value === undefined || value === null) return undefined;

    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestException(
            `${channelType} channel config field "${key}" must be an object`,
        );
    }

    const entries = Object.entries(value as Record<string, unknown>).map(
        ([field, source]) => {
            if (typeof source !== 'string') {
                throw new BadRequestException(
                    `${channelType} channel config field "${key}.${field}" must be a string`,
                );
            }
            return [field, source] as const;
        },
    );

    return Object.fromEntries(entries);
}

const CHANNEL_TYPE = NotificationChannelType;

export function parseFeishuConfig(config: unknown): FeishuConfig {
    const raw = asRecord(config, CHANNEL_TYPE.FEISHU);
    return {
        webhookUrl: requireUrl(raw, 'webhookUrl', CHANNEL_TYPE.FEISHU),
        secret: optionalString(raw, 'secret', CHANNEL_TYPE.FEISHU),
    };
}

export function parseWecomConfig(config: unknown): WecomConfig {
    const raw = asRecord(config, CHANNEL_TYPE.WECOM);
    return {
        webhookUrl: requireUrl(raw, 'webhookUrl', CHANNEL_TYPE.WECOM),
    };
}

export function parseDingtalkConfig(config: unknown): DingtalkConfig {
    const raw = asRecord(config, CHANNEL_TYPE.DINGTALK);
    return {
        webhookUrl: requireUrl(raw, 'webhookUrl', CHANNEL_TYPE.DINGTALK),
        secret: optionalString(raw, 'secret', CHANNEL_TYPE.DINGTALK),
    };
}

export function parseWechatSubscribeConfig(
    config: unknown,
): WechatSubscribeConfig {
    const type = CHANNEL_TYPE.WECHAT_SUBSCRIBE;
    const raw = asRecord(config, type);
    const miniprogramState = optionalString(
        raw,
        'miniprogramState',
        type,
    ) as WechatSubscribeConfig['miniprogramState'];

    if (
        miniprogramState !== undefined &&
        !['developer', 'trial', 'formal'].includes(miniprogramState)
    ) {
        throw new BadRequestException(
            `${type} channel config field "miniprogramState" must be one of developer, trial, formal`,
        );
    }

    return {
        appId: requireString(raw, 'appId', type),
        appSecret: requireString(raw, 'appSecret', type),
        templateId: requireString(raw, 'templateId', type),
        openIds: requireStringArray(raw, 'openIds', type),
        page: optionalString(raw, 'page', type),
        miniprogramState,
        fields: optionalStringMap(raw, 'fields', type),
    };
}

export function parseEmailConfig(config: unknown): EmailConfig {
    const raw = asRecord(config, CHANNEL_TYPE.EMAIL);
    return { to: requireStringArray(raw, 'to', CHANNEL_TYPE.EMAIL) };
}

/** Validates `config` against the shape required by `type`. */
export function assertChannelConfig(type: string, config: unknown): void {
    switch (type) {
        case CHANNEL_TYPE.FEISHU:
            parseFeishuConfig(config);
            return;
        case CHANNEL_TYPE.WECOM:
            parseWecomConfig(config);
            return;
        case CHANNEL_TYPE.DINGTALK:
            parseDingtalkConfig(config);
            return;
        case CHANNEL_TYPE.WECHAT_SUBSCRIBE:
            parseWechatSubscribeConfig(config);
            return;
        case CHANNEL_TYPE.EMAIL:
            parseEmailConfig(config);
            return;
        default:
            throw new BadRequestException(`Unsupported channel type "${type}"`);
    }
}

const FIELD_RESOLVERS: Record<
    string,
    (payload: NotificationPayload) => string
> = {
    monitorName: (payload) => payload.monitorName,
    monitorType: (payload) => payload.monitorType,
    target: (payload) => payload.target,
    status: (payload) => payload.status,
    previousStatus: (payload) => payload.previousStatus,
    event: (payload) => payload.event,
    failCount: (payload) => String(payload.failCount),
    latency: (payload) =>
        payload.latency === null ? '-' : `${payload.latency}ms`,
    error: (payload) => payload.error ?? '-',
    checkedAt: (payload) => payload.checkedAt.toISOString(),
};

/**
 * Resolves a WeChat template field value: either one of the well-known payload
 * attributes, or the raw string when it is not a known attribute.
 */
export function resolveWechatFieldValue(
    source: string,
    payload: NotificationPayload,
): string {
    const resolver = FIELD_RESOLVERS[source];
    return resolver ? resolver(payload) : source;
}
