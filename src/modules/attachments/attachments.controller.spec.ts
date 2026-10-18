import { AttachmentsController } from './attachments.controller';

function fixture(download: unknown) {
    const service = {
        getDownload: jest.fn().mockResolvedValue({
            attachment: { mimeType: 'image/png', filename: 'a.png' },
            download,
        }),
    };
    const res = { setHeader: jest.fn(), redirect: jest.fn() };

    return {
        service,
        res,
        controller: new AttachmentsController(service as never),
    };
}

describe('AttachmentsController', () => {
    it('lets another origin read a downloaded attachment', async () => {
        const { controller, res } = fixture({
            type: 'redirect',
            url: 'https://cdn.test/a.png',
        });

        await controller.download(
            'task',
            'attachment',
            { sub: 'user', email: 'user@test.dev', globalRole: 'USER' },
            res as never,
        );

        // A separate frontend host fetches this with a Bearer token; helmet's
        // default `same-origin` resource policy would block the read.
        expect(res.setHeader).toHaveBeenCalledWith(
            'Cross-Origin-Resource-Policy',
            'cross-origin',
        );
        expect(res.setHeader).toHaveBeenCalledWith(
            'cache-control',
            'private, no-store',
        );
    });

    it('keeps the policy when streaming from disk', async () => {
        const { controller, res } = fixture({ type: 'stream', stream: {} });

        await controller.download(
            'task',
            'attachment',
            { sub: 'user', email: 'user@test.dev', globalRole: 'USER' },
            res as never,
        );

        expect(res.setHeader).toHaveBeenCalledWith(
            'Cross-Origin-Resource-Policy',
            'cross-origin',
        );
        expect(res.setHeader).toHaveBeenCalledWith(
            'content-disposition',
            'attachment; filename="a.png"',
        );
    });
});
