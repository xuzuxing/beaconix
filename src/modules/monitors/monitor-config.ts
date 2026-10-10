import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { MonitorType } from '../../generated/prisma/enums';
import { validateHttpMonitorConfig } from './http-monitor-config';
import type { HttpMonitorConfig } from './http-monitor-config';
import {
    APPLICATION_MONITOR_TYPES,
    validateApplicationMonitorConfig,
} from './application-monitor-config';
import type { ApplicationMonitorConfig } from './application-monitor-config';

export const CONFIG_VERSION = 1;
export const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME'] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];
export type MonitorConfig =
    | Record<string, never>
    | DnsConfig
    | HttpMonitorConfig
    | ApplicationMonitorConfig;
export type DnsConfig = {
    recordType: DnsRecordType;
    expectedValues?: string[];
};

export function normalizeDomain(value: string): string {
    return domainToASCII(value.replace(/\.$/, '')).toLowerCase();
}

export function isDomain(value: string): boolean {
    const domain = normalizeDomain(value);
    return (
        !!domain &&
        domain.length <= 253 &&
        domain
            .split('.')
            .every((label) =>
                /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
            )
    );
}

export function normalizeDnsValue(
    recordType: DnsRecordType,
    value: string,
): string {
    if (recordType === 'CNAME') return normalizeDomain(value);
    return recordType === 'AAAA'
        ? new URL(`http://[${value}]/`).hostname.slice(1, -1)
        : value;
}

/** PATCH replaces config; service callers and persisted data use the same validator. */
export function validateMonitorConfig(
    type: MonitorType,
    input: unknown = {},
): MonitorConfig {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new BadRequestException('config must be an object');
    }
    const config = input as Record<string, unknown>;
    const keys = Object.keys(config);
    if (type === MonitorType.HTTP) return validateHttpMonitorConfig(input);
    if (APPLICATION_MONITOR_TYPES.includes(type))
        return validateApplicationMonitorConfig(type, config);
    if (type !== MonitorType.DNS) {
        if (keys.length) {
            throw new BadRequestException(`${type} config must be empty`);
        }
        return {};
    }
    if (keys.some((key) => !['recordType', 'expectedValues'].includes(key))) {
        throw new BadRequestException('Unknown DNS config field');
    }
    const recordType =
        config.recordType === undefined ? 'A' : config.recordType;
    if (!DNS_RECORD_TYPES.includes(recordType as DnsRecordType)) {
        throw new BadRequestException('recordType must be A, AAAA or CNAME');
    }
    const typeName = recordType as DnsRecordType;
    if (config.expectedValues === undefined) return { recordType: typeName };
    const values = config.expectedValues;
    if (
        !Array.isArray(values) ||
        values.length < 1 ||
        values.length > 32 ||
        !values.every(
            (value: unknown) =>
                typeof value === 'string' &&
                value.length <= 253 &&
                (typeName === 'CNAME'
                    ? isDomain(value) && !isIP(value)
                    : isIP(value) === (typeName === 'A' ? 4 : 6)),
        )
    ) {
        throw new BadRequestException(
            'expectedValues must contain 1-32 valid records of recordType',
        );
    }
    return {
        recordType: typeName,
        expectedValues: [
            ...new Set(
                values.map((value: string) =>
                    normalizeDnsValue(typeName, value),
                ),
            ),
        ].sort(),
    };
}
