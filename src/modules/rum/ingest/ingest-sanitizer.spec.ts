import { sanitizeRumError } from './ingest-sanitizer';

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
});
