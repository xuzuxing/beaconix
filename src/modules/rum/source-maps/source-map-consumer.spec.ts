import { parseSourceMap } from './source-map-consumer';

describe('Source Map v3 consumer', () => {
    it('maps generated positions and applies sourceRoot', () => {
        const map = parseSourceMap(
            JSON.stringify({
                version: 3,
                sourceRoot: 'webpack://app',
                sources: ['src/main.ts'],
                names: [],
                mappings: 'AAAA',
            }),
        );
        expect(map.originalPositionFor(1, 0)).toEqual({
            source: 'webpack://app/src/main.ts',
            line: 1,
            column: 1,
            name: null,
        });
    });

    it('rejects malformed maps', () => {
        expect(() => parseSourceMap('{')).toThrow('valid JSON');
        expect(() =>
            parseSourceMap(
                JSON.stringify({ version: 2, sources: [], mappings: '' }),
            ),
        ).toThrow('v3');
    });
});
