import { PublicAttachmentsController } from './public-attachments.controller';

function fixture(download: unknown) {
    const service = {
        getPublicObjectDownload: jest.fn().mockResolvedValue({
            filename: 'photo.jpg',
            mimeType: 'image/jpeg',
            download,
        }),
    };
    const res = {
        setHeader: jest.fn(),
        redirect: jest.fn(),
    };
    const request = { headers: {} };

    return {
        service,
        res,
        request: request as never,
        controller: new PublicAttachmentsController(service as never),
    };
}

describe('PublicAttachmentsController', () => {
    it('lets another origin read a signed object', async () => {
        const { controller, service, res, request } = fixture({
            type: 'redirect',
            url: 'https://cdn.test/tickets/x.jpg',
        });

        await controller.object(
            {
                key: 'tickets/2026/10/x.jpg',
                exp: Math.floor(Date.now() / 1000) + 60,
                sig: 'a'.repeat(64),
            },
            request,
            res as never,
        );

        // Without this header helmet's `same-origin` policy makes the browser
        // drop a 200 with ERR_BLOCKED_BY_RESPONSE.NotSameOrigin.
        expect(res.setHeader).toHaveBeenCalledWith(
            'Cross-Origin-Resource-Policy',
            'cross-origin',
        );
        expect(service.getPublicObjectDownload).toHaveBeenCalled();
        expect(res.redirect).toHaveBeenCalledWith(
            'https://cdn.test/tickets/x.jpg',
        );
    });

    it('sets the policy on streamed objects as well', async () => {
        const { controller, res, request } = fixture({
            type: 'stream',
            stream: {},
        });

        await controller.object(
            { key: 'avatars/2026/10/a.png' },
            request,
            res as never,
        );

        expect(res.setHeader).toHaveBeenCalledWith(
            'Cross-Origin-Resource-Policy',
            'cross-origin',
        );
        expect(res.setHeader).toHaveBeenCalledWith(
            'content-type',
            'image/jpeg',
        );
    });
});
