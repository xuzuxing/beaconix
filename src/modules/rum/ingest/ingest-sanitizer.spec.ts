import { rumErrorContextSize, sanitizeRumError } from './ingest-sanitizer';

describe('sanitizeRumError', () => {
    it('removes URL query data and redacts common secrets', () => {
        expect(
            sanitizeRumError({
                publicKey: 'rum-key',
                type: ' error ',
                message: 'Authorization: Bearer abc.def.ghi password=hunter2',
                stack: 'token=secret-value',
                page: 'https://example.com/path?token=secret#fragment',
            }),
        ).toMatchObject({
            type: 'error',
            message: 'Authorization: [REDACTED] [REDACTED] password=[REDACTED]',
            stack: 'token=[REDACTED]',
            page: 'https://example.com/path',
        });
    });

    it('redacts nested context and strips URL query data', () => {
        const error = sanitizeRumError({
            publicKey: 'rum-key',
            type: 'fetch',
            message: 'request failed',
            http: {
                method: 'get',
                url: 'https://api.example.com/users/1?access_token=secret',
                status: 500,
                requestId: 'request-1',
            },
            breadcrumbs: [
                {
                    type: 'http',
                    occurredAt: '2026-11-04T08:00:00.000Z',
                    data: {
                        url: 'https://api.example.com/profile?token=secret',
                        authorization: 'Bearer abc',
                        nested: { password: 'hunter2' },
                    },
                },
            ],
        });

        expect(error).toMatchObject({
            category: 'JAVASCRIPT',
            requestId: 'request-1',
            http: {
                method: 'GET',
                url: 'https://api.example.com/users/1',
                status: 500,
                requestId: 'request-1',
            },
            breadcrumbs: [
                {
                    data: {
                        url: 'https://api.example.com/profile',
                        authorization: '[REDACTED]',
                        nested: { password: '[REDACTED]' },
                    },
                },
            ],
        });
    });

    it('measures breadcrumb and structured context as UTF-8 bytes', () => {
        const error = sanitizeRumError({
            publicKey: 'rum-key',
            type: 'Error',
            message: 'failed',
            breadcrumbs: [
                {
                    type: 'console',
                    occurredAt: '2026-11-04T08:00:00.000Z',
                    data: { message: '汉字' },
                },
            ],
        });

        expect(rumErrorContextSize(error)).toBe(
            Buffer.byteLength(
                JSON.stringify({
                    http: error.http,
                    resource: error.resource,
                    vue: error.vue,
                    breadcrumbs: error.breadcrumbs,
                    sdk: error.sdk,
                }),
                'utf8',
            ),
        );
    });
});
