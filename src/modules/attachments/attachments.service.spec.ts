import {
    ConflictException,
    ForbiddenException,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
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
        fileKey: 'attachments/org/task/2026/10/report.txt',
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
            findMany: jest.fn().mockResolvedValue([]),
            delete: jest.fn().mockResolvedValue(attachment),
            create: jest.fn().mockResolvedValue(attachment),
            update: jest.fn().mockResolvedValue(attachment),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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
        activeProviderName: jest.fn().mockResolvedValue('LOCAL'),
    };
    const objectUrls = {
        toObjectUrl: jest.fn().mockResolvedValue('signed-url'),
        toPublicUrl: jest.fn().mockResolvedValue('public-url'),
        verify: jest.fn().mockReturnValue(false),
    };
    const jwtService = { verifyAsync: jest.fn() };
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
        objectUrls,
        jwtService,
        service: new AttachmentsService(
            db as never,
            storage as never,
            settings as never,
            new ProjectAccessService(db as never),
            jwtService as never,
            objectUrls as never,
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
                key: 'attachments/org/task/object',
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
            'attachments/org/task/object',
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
        'attachments/org/task/../../other/object',
        'attachments/org/task/%2e%2e/object',
        'attachments/org/other/object',
        'avatars/2026/10/public-object',
        // Keys written before the split no longer resolve to a task.
        'organizations/org/tasks/task/2026/10/legacy-object',
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

describe('AttachmentsService.claimForTicket', () => {
    const uploader = 'user';
    const ref = {
        filename: 'report.txt',
        mimeType: 'text/plain',
        size: 5,
        url: '/api/attachments/object?key=users/user/2026/10/report.txt',
        fileKey: 'users/user/2026/10/report.txt',
    };
    const unowned = {
        id: 'attachment',
        filename: 'report.txt',
        mimeType: 'text/plain',
        size: 5,
        url: '',
        fileKey: ref.fileKey,
        storageProvider: 'LOCAL',
        bucket: null,
        checksum: null,
        source: 'UPLOAD',
        visibility: 'PUBLIC',
        taskId: null,
        ticketId: null,
        ticketReplyId: null,
        uploadedById: uploader,
    };

    it('claims an unowned upload for the caller', async () => {
        const { service, db } = fixture();
        db.attachment.findMany.mockResolvedValue([unowned]);

        const claimed = await service.claimForTicket(
            db as never,
            [ref],
            { ticketId: 'ticket-1' },
            uploader,
        );

        expect(db.attachment.updateMany).toHaveBeenCalledWith({
            where: {
                fileKey: { in: [ref.fileKey] },
                taskId: null,
                ticketId: null,
                ticketReplyId: null,
            },
            data: { ticketId: 'ticket-1' },
        });
        expect(claimed[0]).toMatchObject({
            id: 'attachment',
            ticketId: 'ticket-1',
        });
    });

    it('returns nothing when no attachments were sent', async () => {
        const { service, db } = fixture();

        await expect(
            service.claimForTicket(
                db as never,
                [],
                { ticketId: 't' },
                uploader,
            ),
        ).resolves.toEqual([]);
        expect(db.attachment.findMany).not.toHaveBeenCalled();
    });

    it('rejects an attachment uploaded by another user', async () => {
        const { service, db } = fixture();
        db.attachment.findMany.mockResolvedValue([
            { ...unowned, uploadedById: 'other' },
        ]);

        await expect(
            service.claimForTicket(
                db as never,
                [ref],
                { ticketId: 't' },
                uploader,
            ),
        ).rejects.toThrow(ForbiddenException);
        expect(db.attachment.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an attachment that already belongs to a host', async () => {
        const { service, db } = fixture();
        db.attachment.findMany.mockResolvedValue([
            { ...unowned, taskId: 'task' },
        ]);

        await expect(
            service.claimForTicket(
                db as never,
                [ref],
                { ticketId: 't' },
                uploader,
            ),
        ).rejects.toThrow(ConflictException);
    });

    it('rejects missing, duplicated and oversized uploads', async () => {
        const { service, db } = fixture();
        db.attachment.findMany.mockResolvedValue([]);
        await expect(
            service.claimForTicket(
                db as never,
                [ref],
                { ticketId: 't' },
                uploader,
            ),
        ).rejects.toThrow('missing or expired');

        await expect(
            service.claimForTicket(
                db as never,
                [ref, ref],
                { ticketId: 't' },
                uploader,
            ),
        ).rejects.toThrow('Duplicate');

        db.attachment.findMany.mockResolvedValue([
            { ...unowned, size: 6 * 1024 * 1024 },
        ]);
        await expect(
            service.claimForTicket(
                db as never,
                [ref],
                { ticketId: 't' },
                uploader,
            ),
        ).rejects.toThrow('5MB');
    });

    it('rejects more than five attachments and unsupported types', async () => {
        const { service, db } = fixture();
        const six = Array.from({ length: 6 }, (_, index) => ({
            ...ref,
            fileKey: `users/user/${index}.txt`,
        }));
        await expect(
            service.claimForTicket(
                db as never,
                six,
                { ticketId: 't' },
                uploader,
            ),
        ).rejects.toThrow('At most 5');

        db.attachment.findMany.mockResolvedValue([
            { ...unowned, mimeType: 'image/svg+xml', filename: 'logo.svg' },
        ]);
        await expect(
            service.claimForTicket(
                db as never,
                [ref],
                { ticketId: 't' },
                uploader,
            ),
        ).rejects.toThrow('Unsupported');
    });
});

describe('AttachmentsService public uploads', () => {
    const file = {
        buffer: Buffer.from('png'),
        originalname: 'avatar.png',
        mimetype: 'image/png',
        size: 3,
    } as Express.Multer.File;

    it('hands out a permanent unsigned link for an avatar upload', async () => {
        const { service, storage, objectUrls } = fixture();
        storage.putObject.mockResolvedValue({
            key: 'avatars/2026/10/avatar.png',
            provider: 'LOCAL',
            url: '',
            bucket: null,
        });

        const result = await service.uploadPublic(file, 'user', 'avatars');

        // A stored avatar URL outlives any signature TTL, so it must not carry
        // exp/sig at all.
        expect(objectUrls.toObjectUrl).not.toHaveBeenCalled();
        expect(objectUrls.toPublicUrl).toHaveBeenCalledWith(
            'avatars/2026/10/avatar.png',
            '',
        );
        expect(result.url).toBe('public-url');
        expect(storage.putObject.mock.calls[0][0]).toMatchObject({
            directory: 'avatars',
            visibility: 'PUBLIC',
        });
    });

    it('passes the storage public URL through so a static host serves it', async () => {
        const { service, storage, objectUrls } = fixture();
        storage.putObject.mockResolvedValue({
            key: 'avatars/2026/10/avatar.png',
            provider: 'LOCAL',
            url: 'https://static.test/avatars/2026/10/avatar.png',
            bucket: null,
        });

        await service.uploadPublic(file, 'user', 'avatars');

        expect(objectUrls.toPublicUrl).toHaveBeenCalledWith(
            'avatars/2026/10/avatar.png',
            'https://static.test/avatars/2026/10/avatar.png',
        );
    });

    it('defaults a general upload to the uploads directory', async () => {
        const { service, storage } = fixture();
        storage.putObject.mockResolvedValue({
            key: 'uploads/2026/10/avatar.png',
            provider: 'LOCAL',
            url: '',
            bucket: null,
        });

        await service.uploadPublic(file, 'user');

        expect(storage.putObject.mock.calls[0][0]).toMatchObject({
            directory: 'uploads',
            visibility: 'PUBLIC',
        });
    });

    it('keeps signing ticket uploads and files them privately', async () => {
        const { service, storage, objectUrls } = fixture();
        storage.putObject.mockResolvedValue({
            key: 'tickets/2026/10/log.txt',
            provider: 'LOCAL',
            url: '',
            bucket: null,
        });

        await service.uploadPublic(file, 'user', 'tickets');

        expect(storage.putObject.mock.calls[0][0]).toMatchObject({
            directory: 'tickets',
            visibility: 'PRIVATE',
        });
        expect(objectUrls.toPublicUrl).not.toHaveBeenCalled();
        expect(objectUrls.toObjectUrl).toHaveBeenCalledWith(
            'tickets/2026/10/log.txt',
            'LOCAL',
            null,
        );
    });

    it.each(['attachments', 'attachments/org/task', 'temp', 'organizations'])(
        'refuses to write the reserved private directory %s as a public upload',
        async (directory) => {
            const { service, storage } = fixture();

            await expect(
                service.uploadPublic(file, 'user', directory),
            ).rejects.toThrow('Reserved attachment directory');
            expect(storage.putObject).not.toHaveBeenCalled();
        },
    );
});

describe('AttachmentsService.getPublicObjectDownload', () => {
    it('serves a public key to an anonymous request', async () => {
        const { service, storage, jwtService, db } = fixture();
        storage.getDownload.mockResolvedValue({
            type: 'redirect',
            url: 'https://cdn.test/avatars/2026/10/avatar.png',
        });

        const result = await service.getPublicObjectDownload({
            key: 'avatars/2026/10/avatar.png',
        });

        expect(result.download).toEqual({
            type: 'redirect',
            url: 'https://cdn.test/avatars/2026/10/avatar.png',
        });
        expect(jwtService.verifyAsync).not.toHaveBeenCalled();
        expect(db.attachment.findFirst).not.toHaveBeenCalled();
        // Nothing is being vouched for, so a configured public base URL may
        // serve the object directly.
        expect(storage.getDownload).toHaveBeenCalledWith(
            'LOCAL',
            'avatars/2026/10/avatar.png',
            undefined,
            'PUBLIC',
            { followPublicUrl: true },
        );
    });

    it('still requires a token for an unsigned ticket key', async () => {
        const { service, jwtService } = fixture();

        await expect(
            service.getPublicObjectDownload({ key: 'tickets/2026/10/x.png' }),
        ).rejects.toThrow(UnauthorizedException);
        expect(jwtService.verifyAsync).not.toHaveBeenCalled();
    });

    it('requires a token for an unsigned task attachment key', async () => {
        const { service, jwtService } = fixture();

        await expect(
            service.getPublicObjectDownload({
                key: 'attachments/org/task/2026/10/x.png',
            }),
        ).rejects.toThrow(UnauthorizedException);
        expect(jwtService.verifyAsync).not.toHaveBeenCalled();
    });

    it('streams a signed private link from the private space', async () => {
        const { service, storage, objectUrls } = fixture();
        objectUrls.verify.mockReturnValue(true);
        storage.getDownload.mockResolvedValue({
            type: 'redirect',
            url: 'https://cdn.test/tickets/2026/10/x.png',
        });

        await service.getPublicObjectDownload({
            key: 'tickets/2026/10/x.png',
            exp: Math.floor(Date.now() / 1000) + 60,
            sig: 'a'.repeat(64),
        });

        expect(storage.getDownload).toHaveBeenCalledWith(
            'LOCAL',
            'tickets/2026/10/x.png',
            undefined,
            // The key decides the space: a ticket object is private even though
            // this endpoint also serves public avatars.
            'PRIVATE',
            { followPublicUrl: false },
        );
    });
});
