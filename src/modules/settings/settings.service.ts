import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { SettingValueType } from '../../generated/prisma/enums';
import { PrismaService } from '../../infra/database/prisma.service';
import { UpdateSettingDto } from './dto';
import { SettingEntity, SettingOptionEntity } from './entities';
import {
    CUSTOM_SETTING_GROUP,
    SETTING_DEFINITION_MAP,
    SETTING_DEFINITIONS,
    SettingDefinition,
} from './settings.defaults';
import { isValidStringArray, normalizeStringArray } from './settings.util';

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

/** `settings` 行的形状 */
interface SettingRow {
    key: string;
    name: string;
    value: unknown;
    valueType: SettingValueType;
    description: string | null;
    isSecret: boolean;
    /** 是否被平台覆盖过；seed 写入的内置行是 false */
    overridden: boolean;
    updatedById: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const CACHE_TTL_MS = 30_000;

@Injectable()
export class SettingsService {
    private readonly logger = new Logger(SettingsService.name);
    private readonly valueCache = new Map<string, CacheEntry>();
    /** `getOverriddenValue` 的缓存键与 `valueCache` 分开，语义不同不能混用 */
    private readonly overrideCache = new Map<string, CacheEntry>();

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
                return this.entityFromRow(row, definition);
            }

            return this.entityFromDefinition(definition);
        });
        const custom = [...rowMap.values()].map((row) =>
            this.entityFromRow(row, undefined),
        );

        // 内置项按 SETTING_DEFINITIONS 的定义顺序返回（管理页据此展示同一 tab
        // 内的顺序），DB 里多出来的非内置行按 key 追加在末尾。
        return this.deriveSections([...defaults, ...custom]);
    }

    async findOne(key: string): Promise<SettingEntity> {
        const definition = SETTING_DEFINITION_MAP.get(key);
        const row = await this.prisma.setting.findUnique({ where: { key } });
        if (row) {
            return this.entityFromRow(row, definition);
        }

        if (!definition) {
            throw new NotFoundException('Setting not found');
        }

        return this.entityFromDefinition(definition);
    }

    /**
     * 公开端点用的配置快照：只取 `isPublic` 的内置项，并强制剔除 secret
     * （即使有人误把某个 secret 项标成公开，也不会出现在响应里）。
     * 返回扁平的 `{ key: value }`，前端不必再按 entity 拆。
     */
    async findPublic(): Promise<Record<string, unknown>> {
        const allowed = new Set(
            SETTING_DEFINITIONS.filter(
                (definition) => definition.isPublic && !definition.isSecret,
            ).map((definition) => definition.key),
        );

        const snapshot: Record<string, unknown> = {};
        for (const entity of await this.findAll()) {
            if (!allowed.has(entity.key) || entity.isSecret) continue;
            snapshot[entity.key] = entity.value;
        }

        return snapshot;
    }

    /**
     * 只覆盖值。元数据（name / group / valueType / isSecret / description）
     * 由内置定义维护，接口改不动，避免把元数据写坏（例如 valueType 被改成
     * STRING 后存量 JSON 值再也解析不出来）。
     */
    async update(
        key: string,
        dto: UpdateSettingDto,
        updatedById?: string,
    ): Promise<SettingEntity> {
        const definition = SETTING_DEFINITION_MAP.get(key);
        if (!definition) {
            throw new NotFoundException('Setting not found');
        }
        const value = this.normalizeValue(dto.value, definition.valueType);
        this.validateSetting(definition, value);

        const row = await this.prisma.setting.upsert({
            where: { key },
            create: {
                key,
                name: definition.name,
                value,
                valueType: definition.valueType,
                description: definition.description,
                isSecret: definition.isSecret ?? false,
                overridden: true,
                updatedById,
            },
            update: {
                value,
                overridden: true,
                updatedById,
            },
        });

        this.valueCache.delete(key);
        this.overrideCache.delete(key);
        return this.entityFromRow(row, definition);
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

    /**
     * 只读「管理页是否覆盖过」的值：DB 行存在且 `overridden` 为 true 时返回
     * 该值，否则返回 undefined。
     *
     * 与 `getString` / `getNumber` 等读取方法的区别是**不做内置默认兜底**。
     * 调用方要判断「用户从未在管理页改过这一项」并回退到自己的环境变量时，
     * 只能靠 undefined：若走 `getString`，DB 无行或 seed 行返回的是内置默认值，
     * 反而会把 .env 里的既有配置盖掉。
     */
    async getOverriddenValue(key: string): Promise<unknown> {
        const cached = this.overrideCache.get(key);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.value;
        }

        const row = await this.prisma.setting.findUnique({
            where: { key },
            select: { value: true, overridden: true },
        });
        const value = row?.overridden ? row.value : undefined;

        this.overrideCache.set(key, {
            value,
            expiresAt: Date.now() + CACHE_TTL_MS,
        });

        return value;
    }

    /**
     * 没显式声明 `section` 的项按 key 的第二段自动归类，新增 tab 时不必再改代码。
     *
     * 规则是「全或无」：只有同一个 tab 内每一项的 key 都能切出第二段
     * （`wechat.pay.mchId` → `pay`）时才自动分段，否则整组平铺。否则像
     * `storage.driver` 这样的两层 key 会让同组的三层 key 形成带标题的块，
     * 与无标题的项混排。显式声明的 `section` 永远优先于推断。
     */
    private deriveSections(entities: SettingEntity[]): SettingEntity[] {
        const byGroup = new Map<string, SettingEntity[]>();
        entities.forEach((entity) => {
            const list = byGroup.get(entity.group);
            if (list) list.push(entity);
            else byGroup.set(entity.group, [entity]);
        });

        byGroup.forEach((items) => {
            const derivable = items.every(
                (item) => item.key.split('.').length >= 3,
            );
            if (!derivable) return;

            items.forEach((item) => {
                if (item.section !== undefined) return;
                item.section = item.key.split('.')[1];
            });
        });

        return entities;
    }

    private entityFromRow(
        row: SettingRow,
        definition: SettingDefinition | undefined,
    ): SettingEntity {
        // overridden 只是表上的记账列，不进 API 响应
        const { overridden, ...rest } = row;
        const isSecret = row.isSecret;
        return new SettingEntity({
            ...rest,
            group: definition?.group ?? CUSTOM_SETTING_GROUP,
            section: definition?.section,
            value: isSecret
                ? null
                : this.presentValue(row.key, row.value, definition),
            isDefault: !overridden,
            options: this.optionsOf(definition),
            min: definition?.min,
            max: definition?.max,
        });
    }

    private entityFromDefinition(definition: SettingDefinition): SettingEntity {
        return new SettingEntity({
            key: definition.key,
            name: definition.name,
            group: definition.group,
            section: definition.section,
            value: this.presentValue(
                definition.key,
                definition.value,
                definition,
            ),
            valueType: definition.valueType,
            description: definition.description,
            isSecret: definition.isSecret ?? false,
            updatedById: null,
            isDefault: true,
            createdAt: null,
            updatedAt: null,
            options: this.optionsOf(definition),
            min: definition.min,
            max: definition.max,
        });
    }

    private optionsOf(
        definition?: SettingDefinition,
    ): SettingOptionEntity[] | undefined {
        if (!definition?.allowedValues?.length) return undefined;

        return definition.allowedValues.map(
            (value) =>
                new SettingOptionEntity({
                    label: definition.optionLabels?.[value] ?? value,
                    value,
                }),
        );
    }

    /**
     * 读取时的兜底：声明了 `stringArray` 的项，存量值不合法时规范化后再返回
     * （非数组 / 没有合法项时回退内置默认），绝不把非法值原样交给前端。
     */
    private presentValue(
        key: string,
        value: unknown,
        definition?: SettingDefinition,
    ): unknown {
        if (!definition?.stringArray) return value;

        const normalized = normalizeStringArray(value);
        if (!normalized) {
            this.logger.warn(
                `${key} holds an invalid string array; serving the built-in default`,
            );
            return definition.value;
        }
        if (!isValidStringArray(value)) {
            this.logger.warn(
                `${key} holds an invalid string array; serving a normalized value`,
            );
        }

        return normalized;
    }

    private normalizeValue(
        value: unknown,
        valueType: SettingValueType,
    ): Prisma.InputJsonValue {
        if (value === undefined || value === null) {
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

        if (typeof value !== 'object') {
            throw new BadRequestException(
                'value must be a JSON object or array',
            );
        }

        return value;
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
    ): void {
        if (
            definition.allowedValues &&
            (typeof value !== 'string' ||
                !definition.allowedValues.includes(value))
        ) {
            throw new BadRequestException(
                `${definition.key} must be one of: ${definition.allowedValues.join(', ')}`,
            );
        }

        if (definition.stringArray && !isValidStringArray(value)) {
            throw new BadRequestException(
                `${definition.key} must be a non-empty array of unique strings`,
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

        if (definition.email && typeof value === 'string' && value) {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
                throw new BadRequestException(
                    `${definition.key} must be a valid email address`,
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
