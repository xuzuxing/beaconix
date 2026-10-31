import { httpPath, normalizeGlobalPrefix } from './http-path';

describe('HTTP paths', () => {
    it.each([
        ['/api', '/api'],
        ['api/', '/api'],
        [' /backend/ ', '/backend'],
        ['', ''],
        ['/', ''],
        ['//v1/backend//', '/v1/backend'],
    ])('normalizes %j', (raw, expected) => {
        expect(normalizeGlobalPrefix(raw)).toBe(expected);
        expect(httpPath(raw, '/health/live')).toBe(`${expected}/health/live`);
    });
    it.each(['/api?token=x', '/a//b', 'https://example.test', '/a/../b'])(
        'rejects invalid prefix %s',
        (raw) => {
            expect(() => normalizeGlobalPrefix(raw)).toThrow();
        },
    );
});
