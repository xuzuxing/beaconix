import {
    buildPrivateObjectKey,
    buildPublicObjectKey,
    isPrivateObjectKey,
    isPublicUploadKey,
    isTaskUploadKey,
    normalizeUploadDirectory,
    sanitizeFilename,
} from './filename.util';

describe('filename utilities', () => {
    it('sanitizes path separators and unsafe characters', () => {
        expect(sanitizeFilename('../foo/bar?.pdf')).toBe('..-foo-bar-.pdf');
    });

    it('files a task attachment under the private attachments space', () => {
        expect(
            buildPrivateObjectKey({
                organizationId: 'org_1',
                taskId: 'task_1',
                objectId: 'object_1',
                filename: 'design spec.pdf',
                now: new Date('2026-10-07T00:00:00.000Z'),
            }),
        ).toBe('attachments/org_1/task_1/2026/10/object_1-design spec.pdf');
    });

    it('files a private upload without a task under the ticket space', () => {
        const now = new Date('2026-10-07T00:00:00.000Z');

        expect(
            buildPrivateObjectKey({
                directory: 'tickets',
                objectId: 'object_1',
                filename: 'error.log',
                now,
            }),
        ).toBe('tickets/2026/10/object_1-error.log');

        // No directory at all still lands in the ticket space, never in the
        // public root.
        expect(
            buildPrivateObjectKey({
                objectId: 'object_1',
                filename: 'a.log',
                now,
            }),
        ).toBe('tickets/2026/10/object_1-a.log');
    });

    it.each(['report.txt%20', 'report.%2e%2e', 'report.opaque#private'])(
        'generated object keys remain downloadable for %s',
        (filename) => {
            const now = new Date('2026-10-07T00:00:00.000Z');
            const privateKey = buildPrivateObjectKey({
                organizationId: 'org_1',
                taskId: 'task_1',
                objectId: 'object_1',
                filename,
                now,
            });

            expect(isTaskUploadKey(privateKey, 'org_1', 'task_1')).toBe(true);
            expect(privateKey).not.toContain('%');
            expect(
                isPublicUploadKey(
                    buildPublicObjectKey({
                        directory: 'uploads',
                        objectId: 'object_1',
                        filename,
                        now,
                    }),
                ),
            ).toBe(true);
        },
    );

    it('builds a public upload key under a sanitized directory', () => {
        expect(
            buildPublicObjectKey({
                directory: '../avatars/raw files',
                objectId: 'object_1',
                filename: '头像.png',
                now: new Date('2026-10-07T00:00:00.000Z'),
            }),
        ).toBe('avatars/raw-files/2026/10/object_1-头像.png');
    });

    it('defaults public uploads to the uploads directory', () => {
        expect(normalizeUploadDirectory(undefined, 'uploads')).toBe('uploads');
        expect(
            buildPublicObjectKey({
                objectId: 'object_1',
                filename: 'a.png',
                now: new Date('2026-10-07T00:00:00.000Z'),
            }),
        ).toBe('uploads/2026/10/object_1-a.png');
    });

    it('separates the public and private key spaces', () => {
        expect(isPublicUploadKey('avatars/2026/10/a.png')).toBe(true);
        expect(isPublicUploadKey('uploads/2026/10/a.png')).toBe(true);
        // Custom public directories stay allowed for existing callers.
        expect(isPublicUploadKey('teams/2026/10/a.png')).toBe(true);

        for (const key of [
            'attachments/org_1/task_1/2026/10/a.png',
            'tickets/2026/10/a.png',
            'temp/2026/10/a.png',
            'organizations/org_1/tasks/task_1/2026/10/a.png',
        ]) {
            expect(isPublicUploadKey(key)).toBe(false);
            expect(isPrivateObjectKey(key)).toBe(true);
        }
    });

    it('keeps malformed or traversing keys out of the public space', () => {
        for (const key of [
            '',
            '../avatars/a.png',
            'avatars/../../a.png',
            'avatars//a.png',
            'avatars/a.png%00',
            'avatars\\a.png',
            'avatars/a:b.png',
        ]) {
            expect(isPublicUploadKey(key)).toBe(false);
        }
    });

    it('only accepts task keys under the new attachments prefix', () => {
        expect(
            isTaskUploadKey(
                'attachments/org_1/task_1/2026/10/a.png',
                'org_1',
                'task_1',
            ),
        ).toBe(true);
        // Keys written before the split no longer resolve to a task.
        expect(
            isTaskUploadKey(
                'organizations/org_1/tasks/task_1/2026/10/a.png',
                'org_1',
                'task_1',
            ),
        ).toBe(false);
    });
});
