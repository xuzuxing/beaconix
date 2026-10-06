import { dueDateChanged } from './tasks.service';

describe('dueDateChanged', () => {
    it('is true when a due date is set, moved or cleared', () => {
        const now = new Date('2026-10-07T09:00:00.000Z');

        expect(dueDateChanged(null, now)).toBe(true);
        expect(dueDateChanged(now, new Date('2026-10-08T09:00:00.000Z'))).toBe(
            true,
        );
        expect(dueDateChanged(now, null)).toBe(true);
    });

    it('is false when the due date stays the same', () => {
        const dueDate = new Date('2026-10-07T09:00:00.000Z');

        expect(dueDateChanged(dueDate, new Date(dueDate.getTime()))).toBe(
            false,
        );
        expect(dueDateChanged(null, null)).toBe(false);
        expect(dueDateChanged(undefined, null)).toBe(false);
    });
});
