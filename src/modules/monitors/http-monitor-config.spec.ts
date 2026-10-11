import {
    DEFAULT_HTTP_BODY_BYTES,
    MAX_HTTP_BODY_BYTES,
    parseJsonPointer,
    validateHttpMonitorConfig,
} from './http-monitor-config';
import { validateMonitorConfig } from './monitor-config';

describe('HTTP monitor configuration', () => {
    it('preserves empty config and normalizes optional defaults deterministically', () => {
        expect(validateMonitorConfig('HTTP')).toEqual({});
        expect(validateHttpMonitorConfig({ keyword: ' healthy ' })).toEqual({
            keyword: ' healthy ',
            keywordMode: 'contains',
            maxBodyBytes: DEFAULT_HTTP_BODY_BYTES,
        });
        expect(
            validateHttpMonitorConfig({
                maxBodyBytes: 1024,
                jsonAssertions: [
                    { value: null, operator: 'eq', path: '/nullable' },
                    { operator: 'notExists', path: '/error' },
                ],
            }),
        ).toEqual({
            jsonAssertions: [
                { path: '/nullable', operator: 'eq', value: null },
                { path: '/error', operator: 'notExists' },
            ],
            maxBodyBytes: 1024,
        });
        expect(
            validateHttpMonitorConfig({
                keyword: 'ok',
                keywordMode: 'notContains',
                maxBodyBytes: MAX_HTTP_BODY_BYTES,
            }).maxBodyBytes,
        ).toBe(MAX_HTTP_BODY_BYTES);
    });

    it('decodes JSON Pointer escapes once and accepts root, empty keys and arrays', () => {
        expect(parseJsonPointer('')).toEqual([]);
        expect(parseJsonPointer('/')).toEqual(['']);
        expect(parseJsonPointer('/a~1b/~0key/0')).toEqual(['a/b', '~key', '0']);
        expect(parseJsonPointer('/~01')).toEqual(['~1']);
    });

    it.each([
        { expectedStatus: 200 },
        { headers: { authorization: 'not-supported' } },
        { keyword: '' },
        { keyword: 'x'.repeat(1025) },
        { keyword: false },
        { keyword: 'ok', keywordMode: null },
        { keyword: 'ok', keywordMode: 'regex' },
        { keywordMode: 'contains' },
        { maxBodyBytes: 1024 },
        { keyword: 'ok', maxBodyBytes: 1023 },
        { keyword: 'ok', maxBodyBytes: MAX_HTTP_BODY_BYTES + 1 },
        { keyword: 'ok', maxBodyBytes: 1024.5 },
        { keyword: 'ok', maxBodyBytes: '1024' },
        { keyword: 'ok', maxBodyBytes: null },
        { jsonAssertions: [] },
        { jsonAssertions: Array(11).fill({ path: '', operator: 'exists' }) },
        { jsonAssertions: [null] },
        { jsonAssertions: [{ path: '$.status', operator: 'eq', value: 'ok' }] },
        { jsonAssertions: [{ path: '/x', operator: 'script', value: 'ok' }] },
        { jsonAssertions: [{ path: '/x', operator: 'eq' }] },
        { jsonAssertions: [{ path: '/x', operator: 'eq', value: {} }] },
        { jsonAssertions: [{ path: '/x', operator: 'eq', value: [] }] },
        { jsonAssertions: [{ path: '/x', operator: 'eq', value: Infinity }] },
        {
            jsonAssertions: [
                { path: '/x', operator: 'eq', value: 'x'.repeat(1025) },
            ],
        },
        { jsonAssertions: [{ path: '/x', operator: 'exists', value: null }] },
        { jsonAssertions: [{ path: '/x', operator: 'exists', extra: true }] },
    ])('rejects unsupported or unbounded input %#', (config) => {
        expect(() => validateHttpMonitorConfig(config)).toThrow();
    });

    it.each([null, [], 'string', Object.create({ keyword: 'inherited' })])(
        'rejects non-plain configuration %#',
        (config) => expect(() => validateHttpMonitorConfig(config)).toThrow(),
    );

    it.each([
        undefined,
        '$.status',
        '/bad~escape',
        '/bad~2escape',
        '/__proto__/polluted',
        '/constructor/name',
        '/prototype',
        '/x'.repeat(17),
        '/x'.repeat(129),
    ])('rejects unsafe JSON Pointer %#', (path) => {
        expect(() => parseJsonPointer(path)).toThrow();
    });
});
