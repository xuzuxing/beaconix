import {
    createRumErrorFingerprint,
    RUM_FINGERPRINT_VERSION,
} from './error-fingerprint';

describe('createRumErrorFingerprint', () => {
    it('is stable within an app and separates apps', () => {
        const error = {
            category: 'JAVASCRIPT' as const,
            type: 'Error',
            message: 'failed 12345',
            stack: 'Error: failed\n    at run (https://example.com/app.js:1:2)',
        };
        const first = createRumErrorFingerprint('app-a', error);
        expect(first).toHaveLength(64);
        expect(first).toBe(createRumErrorFingerprint('app-a', error));
        expect(first).not.toBe(createRumErrorFingerprint('app-b', error));
        expect(RUM_FINGERPRINT_VERSION).toBe(2);
    });

    it('groups dynamic HTTP resource IDs by normalized path', () => {
        const first = createRumErrorFingerprint('app-a', {
            category: 'HTTP',
            type: 'fetch',
            message: 'HTTP 500',
            http: {
                method: 'GET',
                url: 'https://api.example.com/users/123?token=secret',
                status: 500,
            },
        });
        const second = createRumErrorFingerprint('app-a', {
            category: 'HTTP',
            type: 'fetch',
            message: 'HTTP 500',
            http: {
                method: 'GET',
                url: 'https://api.example.com/users/456',
                status: 500,
            },
        });
        expect(first).toBe(second);
    });

    it('normalizes source locations without changing frame punctuation', () => {
        const withParentheses = createRumErrorFingerprint('app-a', {
            category: 'JAVASCRIPT',
            type: 'Error',
            message: 'failed',
            stack: 'Error: failed\n    at run (https://example.com/app.js:10:20)',
        });
        const withoutParentheses = createRumErrorFingerprint('app-a', {
            category: 'JAVASCRIPT',
            type: 'Error',
            message: 'failed',
            stack: 'Error: failed\n    at https://example.com/app.js:30:40',
        });
        const sameWithoutParentheses = createRumErrorFingerprint('app-a', {
            category: 'JAVASCRIPT',
            type: 'Error',
            message: 'changed',
            stack: 'Error: changed\n    at https://example.com/app.js:50:60',
        });

        expect(withParentheses).not.toBe(withoutParentheses);
        expect(withoutParentheses).toBe(sameWithoutParentheses);
    });
});
