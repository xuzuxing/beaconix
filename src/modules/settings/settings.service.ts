import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { SettingValueType } from '../../generated/prisma/enums';
import { PrismaService } from '../../infra/database/prisma.service';
import { UpdateSettingDto } from './dto';
import { SettingEntity } from './entities';
import {
    SETTING_DEFINITION_MAP,
    SETTING_DEFINITIONS,
    SettingDefinition,
} from './settings.defaults';

export interface AttachmentRuntimeSettings {
    maxImageSizeMb: number;
    maxPdfSizeMb: number;
    maxBlobSizeMb: number;
    maxFilesPerRequest: number;
}

interface CacheEntry {
    value: unknown;
    expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const SECRET_MASK = '********';

@Injectable()
export class SettingsService {
    private readonly valueCache = new Map<string, CacheEntry>();

    constructor(private readonly prisma: PrismaService) {}

    async findAll(): Promise<SettingEntity[]> {
        const rows = await this.prisma.setting.findMany({
            orderBy: { key: 'asc' },
        });
        const rowMap = new Map(rows.map((row) => [row.key, row]));
        const defaults = SETTING_DEFINITIONS.map((definition) => {
            const row = rowMap.get(definition.key);
            if (row) {
                rowMap.delete(definition.key);
                return this.entityFromRow(row, false);
            }

            return this.entityFromDefinition(definition);
        });
        const custom = [...rowMap.values()].map((row) =>
            this.entityFromRow(row, false),
        );

        return [...defaults, ...custom].sort((a, b) =>
            a.key.localeCompare(b.key),
        );
    }

    async findOne(key: string): Promise<SettingEntity> {
        const row = await this.prisma.setting.findUnique({ where: { key } });
        if (row) {
            return this.entityFromRow(row, false);
        }

        const definition = SETTING_DEFINITION_MAP.get(key);
        if (!definition) {
            throw new NotFoundException('Setting not found');
        }

        return this.entityFromDefinition(definition);
    }

    async update(
        key: string,
        dto: UpdateSettingDto,
        updatedById?: string,
    ): Promise<SettingEntity> {
        const definition = SETTING_DEFINITION_MAP.get(key);
        if (!definition) {
            throw new NotFoundException('Setting not found');
        }
        const existing = await this.prisma.setting.findUnique({
            where: { key },
        });
        const valueType =
            dto.valueType ?? existing?.valueType ?? definition.valueType;
        const value = this.normalizeValue(dto.value, valueType);
        this.validateSetting(definition, value, valueType);

        const row = await this.prisma.setting.upsert({
            where: { key },
            create: {
                key,
                name: dto.name ?? definition.name,
                value,
                valueType,
                description: dto.description ?? definition.description,
                isSecret: dto.isSecret ?? definition.isSecret ?? false,
                updatedById,
            },
            update: {
                name: dto.name ?? existing?.name ?? definition.name,
                value,
                valueType,
                description:
                    dto.description ??
                    existing?.description ??
                    definition.description,
                isSecret:
                    dto.isSecret ??
                    existing?.isSecret ??
                    definition.isSecret ??
                    false,
                updatedById,
            },
        });

        this.valueCache.delete(key);
        return this.entityFromRow(row, false);
    }

    async getString(key: string, fallback: string): Promise<string> {
        const value = await this.getValue(key);
        if (typeof value === 'string') return value;
        if (value === undefined || value === null) return fallback;
        if (typeof value === 'number' || typeof value === 'boolean') {
            return value.toString();
        }
        return fallback;
    }

    async getNumber(key: string, fallback: number): Promise<number> {
        const value = await this.getValue(key);
        if (value === undefined || value === null || value === '') {
            return fallback;
        }

        const numberValue =
            typeof value === 'number'
                ? value
                : typeof value === 'string'
                  ? this.parseStrictNumber(value)
                  : Number.NaN;
        return Number.isFinite(numberValue) ? numberValue : fallback;
    }

    async getBoolean(key: string, fallback: boolean): Promise<boolean> {
        const value = await this.getValue(key);
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            return ['1', 'true', 'yes'].includes(value.toLowerCase());
        }
        return fallback;
    }

    async getJson<T>(key: string, fallback: T): Promise<T> {
        const value = await this.getValue(key);
        return value === undefined ? fallback : (value as T);
    }

    async getAttachmentSettings(): Promise<AttachmentRuntimeSettings> {
        const [
            maxImageSizeMb,
            maxPdfSizeMb,
            maxBlobSizeMb,
            maxFilesPerRequest,
        ] = await Promise.all([
            this.getNumber('attachments.maxImageSizeMb', 8),
            this.getNumber('attachments.maxPdfSizeMb', 16),
            this.getNumber('attachments.maxBlobSizeMb', 32),
            this.getNumber('attachments.maxFilesPerRequest', 5),
        ]);

        return {
            maxImageSizeMb,
            maxPdfSizeMb,
            maxBlobSizeMb,
            maxFilesPerRequest,
        };
    }

    private async getValue(key: string): Promise<unknown> {
        const cached = this.valueCache.get(key);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.value;
        }

        const row = await this.prisma.setting.findUnique({ where: { key } });
        const value = row?.value ?? SETTING_DEFINITION_MAP.get(key)?.value;
        if (value !== undefined) {
            this.valueCache.set(key, {
                value,
                expiresAt: Date.now() + CACHE_TTL_MS,
            });
        }

        return value;
    }

    private entityFromRow(
        row: {
            key: string;
            name: string;
            value: unknown;
            valueType: SettingValueType;
            description: string | null;
            isSecret: boolean;
            updatedById: string | null;
            createdAt: Date;
            updatedAt: Date;
        },
        isDefault: boolean,
    ): SettingEntity {
        return new SettingEntity({
            ...row,
            value: row.isSecret ? SECRET_MASK : row.value,
            isDefault,
        });
    }

    private entityFromDefinition(definition: SettingDefinition): SettingEntity {
        return new SettingEntity({
            key: definition.key,
            name: definition.name,
            value: definition.value,
            valueType: definition.valueType,
            description: definition.description,
            isSecret: definition.isSecret ?? false,
            updatedById: null,
            isDefault: true,
            createdAt: null,
            updatedAt: null,
        });
    }

    private normalizeValue(
        value: unknown,
        valueType: SettingValueType,
    ): Prisma.InputJsonValue {
        if (value === undefined) {
            throw new BadRequestException('value is required');
        }

        if (valueType === SettingValueType.STRING) {
            if (
                typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean'
            ) {
                return value.toString();
            }
            throw new BadRequestException('value must be a string');
        }
        if (valueType === SettingValueType.NUMBER) {
            const numberValue =
                typeof value === 'number'
                    ? value
                    : typeof value === 'string'
                      ? this.parseStrictNumber(value)
                      : Number.NaN;
            if (!Number.isFinite(numberValue)) {
                throw new BadRequestException('value must be a number');
            }
            return numberValue;
        }
        if (valueType === SettingValueType.BOOLEAN) {
            if (typeof value === 'boolean') return value;
            if (typeof value === 'string') {
                const normalized = value.toLowerCase();
                if (['1', 'true', 'yes'].includes(normalized)) return true;
                if (['0', 'false', 'no'].includes(normalized)) return false;
            }
            throw new BadRequestException('value must be a boolean');
        }

        return value as Prisma.InputJsonValue;
    }

    private parseStrictNumber(value: string): number {
        const normalized = value.trim();
        if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
            return Number.NaN;
        }
        return Number(normalized);
    }

    private validateSetting(
        definition: SettingDefinition,
        value: Prisma.InputJsonValue,
        valueType: SettingValueType,
    ): void {
        if (definition.valueType !== valueType) {
            throw new BadRequestException(
                `${definition.key} must use ${definition.valueType} value type`,
            );
        }

        if (
            definition.allowedValues &&
            (typeof value !== 'string' ||
                !definition.allowedValues.includes(value))
        ) {
            throw new BadRequestException(
                `${definition.key} must be one of: ${definition.allowedValues.join(', ')}`,
            );
        }

        if (definition.url && typeof value === 'string' && value) {
            try {
                const url = new URL(value);
                if (!['http:', 'https:'].includes(url.protocol)) {
                    throw new Error('Unsupported protocol');
                }
            } catch {
                throw new BadRequestException(
                    `${definition.key} must be a valid HTTP(S) URL`,
                );
            }
        }

        if (definition.valueType === SettingValueType.NUMBER) {
            const numericValue = typeof value === 'number' ? value : Number.NaN;
            if (definition.integer && !Number.isInteger(numericValue)) {
                throw new BadRequestException(
                    `${definition.key} must be an integer`,
                );
            }
            if (definition.min !== undefined && numericValue < definition.min) {
                throw new BadRequestException(
                    `${definition.key} must be >= ${definition.min}`,
                );
            }
            if (definition.max !== undefined && numericValue > definition.max) {
                throw new BadRequestException(
                    `${definition.key} must be <= ${definition.max}`,
                );
            }
        }
    }
}
