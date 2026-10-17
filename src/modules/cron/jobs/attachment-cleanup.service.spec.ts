import { AttachmentCleanupService } from './attachment-cleanup.service';

function createService(orphans: unknown[]) {
    const prisma = {
        attachment: {
            findMany: jest.fn().mockResolvedValue(orphans),
            delete: jest.fn().mockResolvedValue({}),
        },
    };
    const storage = { deleteObject: jest.fn().mockResolvedValue(undefined) };
    const registry = { register: jest.fn() };

    return {
        prisma,
        storage,
        registry,
        service: new AttachmentCleanupService(
            prisma as never,
            storage as never,
            registry as never,
        ),
    };
}

describe('AttachmentCleanupService', () => {
    it('registers the scheduled job', () => {
        const { service, registry } = createService([]);

        service.onModuleInit();

        expect(registry.register).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'attachment-cleanup',
                pattern: '30 3 * * *',
            }),
        );
    });

    it('only targets uploads older than a day with no host', async () => {
        const { service, prisma } = createService([]);

        await service.handleAttachmentCleanup();

        const where = prisma.attachment.findMany.mock.calls[0][0].where;
        expect(where).toMatchObject({
            taskId: null,
            ticketId: null,
            ticketReplyId: null,
        });
        expect(where.createdAt.lt).toBeInstanceOf(Date);
        expect(prisma.attachment.delete).not.toHaveBeenCalled();
    });

    it('deletes the stored object and the row', async () => {
        const { service, prisma, storage } = createService([
            {
                id: 'attachment-1',
                fileKey: 'tickets/2026/10/error.log',
                storageProvider: 'LOCAL',
                bucket: null,
            },
            {
                id: 'attachment-2',
                fileKey: null,
                storageProvider: 'LOCAL',
                bucket: 'beaconix-attachments',
            },
        ]);

        await service.handleAttachmentCleanup();

        expect(storage.deleteObject).toHaveBeenCalledTimes(1);
        expect(storage.deleteObject).toHaveBeenCalledWith(
            'LOCAL',
            'tickets/2026/10/error.log',
            null,
        );
        expect(prisma.attachment.delete).toHaveBeenCalledTimes(2);
        expect(prisma.attachment.delete).toHaveBeenCalledWith({
            where: { id: 'attachment-1' },
        });
    });

    it('still removes the row when the object is already gone', async () => {
        const { service, prisma, storage } = createService([
            {
                id: 'attachment-3',
                fileKey: 'tickets/2026/10/missing.log',
                storageProvider: 'LOCAL',
                bucket: null,
            },
        ]);
        storage.deleteObject.mockRejectedValue(new Error('ENOENT'));

        await service.handleAttachmentCleanup();

        expect(prisma.attachment.delete).toHaveBeenCalledWith({
            where: { id: 'attachment-3' },
        });
    });
});
