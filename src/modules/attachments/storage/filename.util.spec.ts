import {
    buildObjectKey,
    buildPublicObjectKey,
    isPublicUploadKey,
    normalizeUploadDirectory,
    normalizeUserUploadDirectory,
    sanitizeFilename,
} from './filename.util';

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

    it('builds a public upload key under a sanitized directory', () => {
        expect(
            buildPublicObjectKey({
                userId: 'user_1',
                directory: '../avatars/raw files',
                objectId: 'object_1',
                filename: '头像.png',
                now: new Date('2026-10-07T00:00:00.000Z'),
            }),
        ).toBe('avatars/raw-files/2026/10/object_1-头像.png');
    });

    it('defaults public upload directory to the current user folder', () => {
        expect(normalizeUserUploadDirectory('user_1')).toBe('users/user_1');
        expect(normalizeUploadDirectory('', 'users/user_1')).toBe(
            'users/user_1',
        );
    });

    it('checks whether an object key belongs to the generic upload space', () => {
        expect(isPublicUploadKey('openchoreo/2026/10/object_1-a.png')).toBe(
            true,
        );
        expect(isPublicUploadKey('users/user_1/2026/10/object_1-a.png')).toBe(
            true,
        );
        expect(
            isPublicUploadKey(
                'organizations/org_1/tasks/task_1/2026/10/object_1-a.png',
            ),
        ).toBe(false);
    });
});
