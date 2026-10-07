import { buildObjectKey, sanitizeFilename } from './filename.util';

describe('filename utilities', () => {
    it('sanitizes path separators and unsafe characters', () => {
        expect(sanitizeFilename('../foo/bar?.pdf')).toBe('..-foo-bar-.pdf');
    });

    it('builds a tenant-scoped object key', () => {
        expect(
            buildObjectKey({
                organizationId: 'org_1',
                taskId: 'task_1',
                objectId: 'object_1',
                filename: 'design spec.pdf',
                now: new Date('2026-10-07T00:00:00.000Z'),
            }),
        ).toBe(
            'organizations/org_1/tasks/task_1/2026/10/object_1-design spec.pdf',
        );
    });
});
