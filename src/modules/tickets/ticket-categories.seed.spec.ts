import {
    DEFAULT_TICKET_CATEGORIES,
    missingTicketCategorySeeds,
} from './ticket-categories.seed';

describe('ticket category seed rows', () => {
    it('names are unique and sortOrder ascends', () => {
        const names = DEFAULT_TICKET_CATEGORIES.map((row) => row.name);
        const sortOrders = DEFAULT_TICKET_CATEGORIES.map(
            (row) => row.sortOrder,
        );

        expect(new Set(names).size).toBe(names.length);
        expect(sortOrders).toEqual([...sortOrders].sort((a, b) => a - b));
        expect(
            DEFAULT_TICKET_CATEGORIES.every(
                (row) => row.description.length > 0,
            ),
        ).toBe(true);
    });

    it('seeds every category into an empty table', () => {
        expect(missingTicketCategorySeeds([])).toHaveLength(
            DEFAULT_TICKET_CATEGORIES.length,
        );
    });

    it('only returns the names the table does not have yet', () => {
        const missing = missingTicketCategorySeeds([
            '计费与订阅',
            '其他问题',
            // 管理端自建的分类不该影响内置项的补齐
            '自定义分类',
        ]);

        const names = missing.map((row) => row.name);
        expect(names).not.toContain('计费与订阅');
        expect(names).not.toContain('其他问题');
        expect(names).toContain('故障与不可用');
        expect(missing).toHaveLength(DEFAULT_TICKET_CATEGORIES.length - 2);
    });

    it('is a no-op once every built-in category exists', () => {
        const allNames = DEFAULT_TICKET_CATEGORIES.map((row) => row.name);

        expect(missingTicketCategorySeeds(allNames)).toEqual([]);
    });
});
