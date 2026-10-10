import { BadRequestException } from '@nestjs/common';

export const DEFAULT_HTTP_BODY_BYTES = 64 * 1024;
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;
export const MAX_JSON_ASSERTIONS = 10;
export const JSON_ASSERTION_OPERATORS = [
    'exists',
    'notExists',
    'eq',
    'neq',
] as const;
export type JsonAssertionOperator = (typeof JSON_ASSERTION_OPERATORS)[number];
export type JsonScalar = string | number | boolean | null;
export type JsonAssertion =
    | { path: string; operator: 'exists' | 'notExists' }
    | { path: string; operator: 'eq' | 'neq'; value: JsonScalar };
export type HttpMonitorConfig = {
    keyword?: string;
    keywordMode?: 'contains' | 'notContains';
    jsonAssertions?: JsonAssertion[];
    maxBodyBytes?: number;
};

function record(input: unknown): Record<string, unknown> {
    if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    ) {
        throw new BadRequestException(
            'HTTP configuration must contain plain objects',
        );
    }
    return input as Record<string, unknown>;
}

/** JSON Pointer only: no wildcards, scripts, recursive search or prototype traversal. */
export function parseJsonPointer(path: unknown): string[] {
    if (
        typeof path !== 'string' ||
        path.length > 256 ||
        (path !== '' && !path.startsWith('/')) ||
        /~(?![01])/.test(path)
    ) {
        throw new BadRequestException(
            'JSON assertion path must be a JSON Pointer of at most 256 characters',
        );
    }
    const parts =
        path === ''
            ? []
            : path
                  .slice(1)
                  .split('/')
                  .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (
        parts.length > 16 ||
        parts.some((part) =>
            ['__proto__', 'prototype', 'constructor'].includes(part),
        )
    ) {
        throw new BadRequestException(
            'JSON assertion path is too deep or contains a forbidden segment',
        );
    }
    return parts;
}

export function validateHttpMonitorConfig(
    input: unknown = {},
): HttpMonitorConfig {
    const config = record(input);
    if (
        Object.keys(config).some(
            (key) =>
                ![
                    'keyword',
                    'keywordMode',
                    'jsonAssertions',
                    'maxBodyBytes',
                ].includes(key),
        )
    ) {
        throw new BadRequestException('Unknown HTTP config field');
    }
    const normalized: HttpMonitorConfig = {};
    if (Object.hasOwn(config, 'keyword')) {
        if (
            typeof config.keyword !== 'string' ||
            config.keyword.length < 1 ||
            config.keyword.length > 1024
        ) {
            throw new BadRequestException(
                'keyword must contain 1-1024 characters',
            );
        }
        const mode = config.keywordMode ?? 'contains';
        if (mode !== 'contains' && mode !== 'notContains') {
            throw new BadRequestException(
                'keywordMode must be contains or notContains',
            );
        }
        if (config.keywordMode === null) {
            throw new BadRequestException('keywordMode cannot be null');
        }
        normalized.keyword = config.keyword;
        normalized.keywordMode = mode;
    } else if (Object.hasOwn(config, 'keywordMode')) {
        throw new BadRequestException('keywordMode requires keyword');
    }
    if (Object.hasOwn(config, 'jsonAssertions')) {
        if (
            !Array.isArray(config.jsonAssertions) ||
            config.jsonAssertions.length < 1 ||
            config.jsonAssertions.length > MAX_JSON_ASSERTIONS
        ) {
            throw new BadRequestException(
                'jsonAssertions must contain 1-10 assertions',
            );
        }
        normalized.jsonAssertions = config.jsonAssertions.map((input) => {
            const assertion = record(input);
            if (
                Object.keys(assertion).some(
                    (key) => !['path', 'operator', 'value'].includes(key),
                )
            ) {
                throw new BadRequestException('Unknown JSON assertion field');
            }
            parseJsonPointer(assertion.path);
            const path = assertion.path as string;
            const operator = assertion.operator as JsonAssertionOperator;
            if (!JSON_ASSERTION_OPERATORS.includes(operator)) {
                throw new BadRequestException(
                    'JSON assertion operator must be exists, notExists, eq or neq',
                );
            }
            if (operator === 'exists' || operator === 'notExists') {
                if (Object.hasOwn(assertion, 'value')) {
                    throw new BadRequestException(
                        'Existence assertions cannot include value',
                    );
                }
                return { path, operator };
            }
            const value = assertion.value;
            if (
                !Object.hasOwn(assertion, 'value') ||
                !(
                    value === null ||
                    typeof value === 'boolean' ||
                    (typeof value === 'number' && Number.isFinite(value)) ||
                    (typeof value === 'string' && value.length <= 1024)
                )
            ) {
                throw new BadRequestException(
                    'JSON assertion value must be a finite scalar (string up to 1024 characters, number, boolean or null)',
                );
            }
            return { path, operator, value };
        });
    }
    if (normalized.keyword !== undefined || normalized.jsonAssertions) {
        const limit = Object.hasOwn(config, 'maxBodyBytes')
            ? config.maxBodyBytes
            : DEFAULT_HTTP_BODY_BYTES;
        if (
            typeof limit !== 'number' ||
            !Number.isInteger(limit) ||
            limit < 1024 ||
            limit > MAX_HTTP_BODY_BYTES
        ) {
            throw new BadRequestException(
                'maxBodyBytes must be an integer between 1024 and 1048576',
            );
        }
        normalized.maxBodyBytes = limit;
    } else if (Object.hasOwn(config, 'maxBodyBytes')) {
        throw new BadRequestException('maxBodyBytes requires a body assertion');
    }
    return normalized;
}
