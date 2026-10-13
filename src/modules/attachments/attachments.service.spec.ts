import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { ProjectAccessService } from '../../common/authorization/project-access.service';
import { AttachmentEntity } from './entities';

function fixture(role = 'ADMIN', uploadedById = 'other') {
    const attachment = {
        id: 'attachment',
        taskId: 'task',
        uploadedById,
        filename: 'report.txt',
        mimeType: 'text/plain',
        visibility: 'PRIVATE',
        source: 'UPLOAD',
        storageProvider: 'LOCAL',
        bucket: null,
        fileKey: 'organizations/org/tasks/task/2026/10/report.txt',
        url: '/api/tasks/task/attachments/attachment/download',
    };
    const db = {
        user: {
            findFirst: jest.fn().mockResolvedValue({ globalRole: 'USER' }),
        },
        organization: { findFirst: jest.fn().mockResolvedValue({ id: 'org' }) },
        membership: {
            findMany: jest.fn().mockResolvedValue([{ id: 'member' }]),
            findUnique: jest
                .fn()
                .mockResolvedValue({ id: 'member', role: 'MEMBER' }),
        },
        projectMembership: {
            findUnique: jest.fn().mockResolvedValue({
                role,
                organizationId: 'org',
            }),
        },
        project: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'project',
                organizationId: 'org',
                status: 'ACTIVE',
            }),
        },
        task: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'task',
                organizationId: 'org',
                projectId: 'project',
            }),
        },
        attachment: {
            findFirst: jest.fn().mockResolvedValue(attachment),
            delete: jest.fn().mockResolvedValue(attachment),
            create: jest.fn().mockResolvedValue(attachment),
            update: jest.fn().mockResolvedValue(attachment),
        },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
        $queryRaw: jest.fn().mockResolvedValue([]),
        $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation((work) => work(db));
    const storage = {
        putObject: jest.fn().mockResolvedValue({
            key: attachment.fileKey,
            provider: 'LOCAL',
            url: '',
            bucket: null,
        }),
        deleteObject: jest.fn().mockResolvedValue(undefined),
        getDownload: jest
            .fn()
            .mockResolvedValue({ type: 'redirect', url: 'private-signed' }),
    };
    const settings = {
        getAttachmentSettings: jest.fn().mockResolvedValue({
            maxBlobSizeMb: 10,
            maxImageSizeMb: 10,
            maxPdfSizeMb: 10,
        }),
    };
    return {
        db,
        storage,
        attachment,
        service: new AttachmentsService(
            db as never,
            storage as never,
            settings as never,
            new ProjectAccessService(db as never),
        ),
        file: {
            buffer: Buffer.from('bytes'),
            originalname: 'report.txt',
            mimetype: 'text/plain',
            size: 5,
        } as Express.Multer.File,
    };
}

describe('Attachments authorization lifecycle', () => {
    it('cleans up an upload if access is revoked before the metadata transaction', async () => {
        const { service, storage, db, file } = fixture();
        storage.putObject.mockImplementation(() => {
            db.projectMembership.findUnique.mockResolvedValue(null);
            return Promise.resolve({
                key: 'organizations/org/tasks/task/object',
                provider: 'LOCAL',
                url: '',
                bucket: null,
            });
        });
        await expect(service.upload('task', 'user', file)).rejects.toThrow(
            NotFoundException,
        );
        expect(db.attachment.create).not.toHaveBeenCalled();
        expect(storage.deleteObject).toHaveBeenCalledWith(
            'LOCAL',
            'organizations/org/tasks/task/object',
            null,
        );
    });

    it('returns only an authenticated download route for first-party uploads', async () => {
        const { service, storage, db, file } = fixture();
        const result = await service.upload('task', 'user', file);
        expect(result).toBeInstanceOf(AttachmentEntity);
        expect(result.url).toBe(
            '/api/tasks/task/attachments/attachment/download',
        );
        expect(db.attachment.create.mock.calls[0][0].data).toMatchObject({
            visibility: 'PRIVATE',
            url: '',
            storageProvider: 'LOCAL',
        });
        expect(storage.putObject.mock.calls[0][0].visibility).toBe('PRIVATE');
    });

    it('does not physically delete when transactional audit fails', async () => {
        const { service, storage, db } = fixture();
        db.auditLog.create.mockRejectedValue(new Error('audit unavailable'));
        await expect(
            service.remove('task', 'attachment', 'user'),
        ).rejects.toThrow('audit unavailable');
        expect(storage.deleteObject).not.toHaveBeenCalled();
    });

    it('retains committed metadata deletion when private physical cleanup fails', async () => {
        const { service, storage, db } = fixture();
        storage.deleteObject.mockRejectedValue(
            new Error('storage unavailable'),
        );
        await expect(
            service.remove('task', 'attachment', 'user'),
        ).resolves.toBeUndefined();
        expect(db.attachment.delete).toHaveBeenCalledTimes(1);
        expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it.each(['VIEWER', 'MEMBER'])(
        'rejects %s deletion of another uploader attachment',
        async (role) => {
            const { service, storage, db } = fixture(role);
            await expect(
                service.remove('task', 'attachment', 'user'),
            ).rejects.toThrow(ForbiddenException);
            expect(db.attachment.delete).not.toHaveBeenCalled();
            expect(storage.deleteObject).not.toHaveBeenCalled();
        },
    );

    it('permits a local project admin to delete another uploader attachment', async () => {
        const { service, storage } = fixture();
        await service.remove('task', 'attachment', 'user');
        expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    });

    it.each([
        'organizations/org/tasks/task/../../other/object',
        'organizations/org/tasks/task/%2e%2e/object',
        'organizations/org/tasks/other/object',
        'users/user/public/object',
    ])('rejects untrusted private locator %s', async (fileKey) => {
        const { service, storage, attachment } = fixture();
        attachment.fileKey = fileKey;
        await expect(
            service.getDownload('task', 'attachment', {
                type: 'USER',
                userId: 'user',
            }),
        ).rejects.toThrow(NotFoundException);
        expect(storage.getDownload).not.toHaveBeenCalled();
    });

    it('does not download UNKNOWN legacy objects even for admins', async () => {
        const { service, attachment, storage } = fixture();
        attachment.visibility = 'UNKNOWN';
        await expect(
            service.getDownload('task', 'attachment', {
                type: 'USER',
                userId: 'user',
            }),
        ).rejects.toThrow(NotFoundException);
        expect(storage.getDownload).not.toHaveBeenCalled();
    });

    it('rejects linking arbitrary public uploads into tasks', async () => {
        const { service, db } = fixture();
        await expect(
            service.save('task', 'user', {
                filename: 'report.txt',
                size: 5,
                mimeType: 'text/plain',
                source: 'UPLOAD',
                url: 'https://public.test/file',
                fileKey: 'users/user/public/file',
                storageProvider: 'LOCAL',
            }),
        ).rejects.toThrow('private upload endpoint');
        expect(db.attachment.create).not.toHaveBeenCalled();
    });
});
