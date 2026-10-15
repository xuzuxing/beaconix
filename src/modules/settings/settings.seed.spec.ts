import { SETTING_DEFINITIONS } from './settings.defaults';
import { missingSettingSeedRows, settingSeedRows } from './settings.seed';

describe('settings seed rows', () => {
    it('mirrors every built-in definition, in order', () => {
        const rows = settingSeedRows();

        expect(rows.map((row) => row.key)).toEqual(
            SETTING_DEFINITIONS.map((definition) => definition.key),
        );
        // group 只由代码定义，不入库
        expect(rows.every((row) => !('group' in row))).toBe(true);
        expect(rows.every((row) => row.overridden === false)).toBe(true);
    });

    it('carries the definition metadata over to the row', () => {
        const row = settingSeedRows().find(
            (entry) => entry.key === 'smtp.password',
        );

        expect(row).toMatchObject({
            name: 'SMTP 密码',
            valueType: 'STRING',
            isSecret: true,
            overridden: false,
        });
    });

    it('adds every row to an empty table', () => {
        expect(missingSettingSeedRows([])).toHaveLength(
            SETTING_DEFINITIONS.length,
        );
    });

    it('only returns the keys the table does not have yet', () => {
        const missing = missingSettingSeedRows([
            'storage.driver',
            'smtp.host',
            // 非内置行（历史遗留）也不该让补齐逻辑漏掉内置项
            'legacy.custom.key',
        ]);

        const keys = missing.map((row) => row.key);
        expect(keys).not.toContain('storage.driver');
        expect(keys).not.toContain('smtp.host');
        expect(keys).toContain('system.siteName');
        expect(missing).toHaveLength(SETTING_DEFINITIONS.length - 2);
    });

    it('is a no-op once every built-in key exists', () => {
        const allKeys = SETTING_DEFINITIONS.map((definition) => definition.key);

        expect(missingSettingSeedRows(allKeys)).toEqual([]);
    });
});
