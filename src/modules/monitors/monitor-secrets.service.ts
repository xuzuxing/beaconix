import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { MonitorModel } from '../../generated/prisma/models';
import type { MonitorRuntimeConfig } from '../../config/monitor.config';
import { MONITOR_SECRET_FIELDS } from './application-monitor-config';

type Context = Pick<MonitorModel, 'organizationId' | 'type' | 'target'>;

@Injectable()
export class MonitorSecretsService {
    private readonly key?: Buffer;

    constructor(config: ConfigService) {
        const value = config.get<MonitorRuntimeConfig>('monitor')?.secretKey;
        if (value) {
            const key = Buffer.from(value, 'base64');
            if (key.length !== 32 || key.toString('base64') !== value) {
                throw new Error(
                    'MONITOR_SECRET_KEY must be a canonical base64 32-byte key',
                );
            }
            this.key = key;
        }
    }

    seal(
        config: object,
        context: Context,
    ): { config: Record<string, any>; credentialsEnc: string | null } {
        const publicConfig = { ...config };
        const secrets: Record<string, string> = {};
        for (const field of MONITOR_SECRET_FIELDS) {
            if (Object.hasOwn(publicConfig, field)) {
                secrets[field] = publicConfig[field];
                delete publicConfig[field];
            }
        }
        if (!Object.keys(secrets).length)
            return { config: publicConfig, credentialsEnc: null };
        if (!this.key)
            throw new ServiceUnavailableException(
                'Monitor credential encryption is not configured',
            );
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(this.aad(context));
        const ciphertext = Buffer.concat([
            cipher.update(JSON.stringify(secrets), 'utf8'),
            cipher.final(),
        ]);
        return {
            config: publicConfig,
            credentialsEnc: [
                'v1',
                iv.toString('base64'),
                cipher.getAuthTag().toString('base64'),
                ciphertext.toString('base64'),
            ].join(':'),
        };
    }

    open(
        monitor: Pick<MonitorModel, 'config' | 'credentialsEnc'> & Context,
    ): Record<string, unknown> {
        const config = { ...(monitor.config as Record<string, unknown>) };
        if (!monitor.credentialsEnc) return config;
        if (!this.key) throw new Error('Monitor credentials unavailable');
        const [version, iv, tag, data, extra] =
            monitor.credentialsEnc.split(':');
        if (version !== 'v1' || !iv || !tag || !data || extra !== undefined)
            throw new Error('Invalid monitor credentials');
        const decipher = createDecipheriv(
            'aes-256-gcm',
            this.key,
            Buffer.from(iv, 'base64'),
        );
        decipher.setAAD(this.aad(monitor));
        decipher.setAuthTag(Buffer.from(tag, 'base64'));
        const secrets = JSON.parse(
            Buffer.concat([
                decipher.update(Buffer.from(data, 'base64')),
                decipher.final(),
            ]).toString('utf8'),
        ) as Record<string, unknown>;
        if (
            !secrets ||
            Object.keys(secrets).some(
                (key) => !MONITOR_SECRET_FIELDS.includes(key as never),
            )
        )
            throw new Error('Invalid monitor credentials');
        return { ...config, ...secrets };
    }

    publicConfig(config: unknown): Record<string, unknown> {
        if (!config || typeof config !== 'object' || Array.isArray(config))
            return {};
        const output = { ...config };
        for (const key of MONITOR_SECRET_FIELDS) delete output[key];
        return output;
    }

    private aad(context: Context): Buffer {
        return Buffer.from(
            JSON.stringify([
                context.organizationId,
                context.type,
                context.target,
            ]),
        );
    }
}
