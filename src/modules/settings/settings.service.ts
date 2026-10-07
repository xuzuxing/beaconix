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

@Injectable()
export class SettingsService {
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
                return new SettingEntity({ ...row, isDefault: false });
            }

            return this.entityFromDefinition(definition);
        });
        const custom = [...rowMap.values()].map(
            (row) => new SettingEntity({ ...row, isDefault: false }),
        );

        return [...defaults, ...custom].sort((a, b) =>
            a.key.localeCompare(b.key),
        );
    }

    async findOne(key: string): Promise<SettingEntity> {
        const row = await this.prisma.setting.findUnique({ where: { key } });
        if (row) {
            return new SettingEntity({ ...row, isDefault: false });
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
        const valueType =
            dto.valueType ?? definition?.valueType ?? this.inferType(dto.value);
        const value = this.normalizeValue(dto.value, valueType);
        this.validateKnownSetting(key, value);

        const row = await this.prisma.setting.upsert({
            where: { key },
            create: {
                key,
                name: dto.name ?? definition?.name ?? key,
                value,
                valueType,
                description: dto.description ?? definition?.description,
                isSecret: dto.isSecret ?? definition?.isSecret ?? false,
                updatedById,
            },
            update: {
                name: dto.name ?? definition?.name ?? key,
                value,
                valueType,
                description: dto.description ?? definition?.description,
                isSecret: dto.isSecret ?? definition?.isSecret ?? false,
                updatedById,
            },
        });

        return new SettingEntity({ ...row, isDefault: false });
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
                  ? Number.parseFloat(value)
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
        const row = await this.prisma.setting.findUnique({ where: { key } });
        if (row) return row.value;

        return SETTING_DEFINITION_MAP.get(key)?.value;
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

    private inferType(value: unknown): SettingValueType {
        switch (typeof value) {
            case 'string':
                return SettingValueType.STRING;
            case 'number':
                return SettingValueType.NUMBER;
            case 'boolean':
                return SettingValueType.BOOLEAN;
            default:
                return SettingValueType.JSON;
        }
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
                      ? Number.parseFloat(value)
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

    private validateKnownSetting(
        key: string,
        value: Prisma.InputJsonValue,
    ): void {
        if (key === 'storage.driver' && value !== 'local' && value !== 'oss') {
            throw new BadRequestException(
                'storage.driver must be local or oss',
            );
        }
    }
}
