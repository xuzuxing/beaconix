import { SettingValueType } from '../../generated/prisma/enums';
import { SETTING_DEFINITIONS, SettingDefinition } from './settings.defaults';

/**
 * 一条待写入 `settings` 表的内置配置行。
 *
 * 真源仍是代码里的 `SETTING_DEFINITIONS`，这里只是把它翻译成表结构，
 * 供 `prisma/seed.ts` 幂等补齐——seed 不自己维护清单。
 */
export interface SettingSeedRow {
    key: string;
    name: string;
    value: SettingDefinition['value'];
    valueType: SettingValueType;
    description: string;
    isSecret: boolean;
    /** seed 写入的行永远不是「被覆盖」；用户改过才由 SettingsService 置为 true */
    overridden: boolean;
}

/** 内置定义 → `settings` 行 */
export function settingSeedRows(): SettingSeedRow[] {
    return SETTING_DEFINITIONS.map((definition) => ({
        key: definition.key,
        name: definition.name,
        value: definition.value,
        valueType: definition.valueType,
        description: definition.description,
        isSecret: definition.isSecret ?? false,
        overridden: false,
    }));
}

/**
 * 只挑出库里还没有的行——幂等补齐的关键：
 * 已经存在的行（用户改过的、或上次 seed 写入的）一律不动。
 */
export function missingSettingSeedRows(
    existingKeys: Iterable<string>,
): SettingSeedRow[] {
    const known = new Set(existingKeys);

    return settingSeedRows().filter((row) => !known.has(row.key));
}
