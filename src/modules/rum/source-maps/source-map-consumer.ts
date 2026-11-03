export interface RawSourceMap {
    version: number;
    file?: string;
    sourceRoot?: string;
    sources: string[];
    names?: string[];
    mappings: string;
}

interface MappingSegment {
    generatedColumn: number;
    sourceIndex: number;
    originalLine: number;
    originalColumn: number;
    nameIndex: number | null;
}

export interface OriginalPosition {
    source: string;
    line: number;
    column: number;
    name: string | null;
}

const BASE64 =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = new Map(
    Array.from(BASE64, (character, index) => [character, index]),
);

function decodeVlq(segment: string): number[] {
    const values: number[] = [];
    let value = 0;
    let shift = 0;
    for (const character of segment) {
        const digit = BASE64_VALUES.get(character);
        if (digit === undefined)
            throw new Error('Source map contains invalid base64 VLQ data');
        const continuation = (digit & 32) !== 0;
        value += (digit & 31) << shift;
        if (continuation) {
            shift += 5;
            continue;
        }
        const negative = (value & 1) === 1;
        const decoded = value >> 1;
        values.push(negative ? -decoded : decoded);
        value = 0;
        shift = 0;
    }
    if (shift !== 0) throw new Error('Source map VLQ segment is incomplete');
    return values;
}

function joinSource(sourceRoot: string | undefined, source: string): string {
    if (!sourceRoot || /^(?:[a-z]+:)?\/\//i.test(source)) return source;
    if (/^(?:[a-z]+:)?\/\//i.test(sourceRoot)) {
        try {
            return new URL(
                source,
                sourceRoot.endsWith('/') ? sourceRoot : `${sourceRoot}/`,
            ).toString();
        } catch {
            return `${sourceRoot.replace(/\/$/, '')}/${source.replace(/^\//, '')}`;
        }
    }
    return `${sourceRoot.replace(/\/$/, '')}/${source.replace(/^\//, '')}`;
}

export class ParsedSourceMap {
    private readonly lines: MappingSegment[][];

    constructor(private readonly map: RawSourceMap) {
        if (map.version !== 3)
            throw new Error('Only Source Map v3 is supported');
        if (!Array.isArray(map.sources) || typeof map.mappings !== 'string')
            throw new Error('Invalid Source Map structure');
        this.lines = this.decodeMappings(map.mappings);
    }

    originalPositionFor(
        generatedLine: number,
        generatedColumn: number,
    ): OriginalPosition | null {
        const segments = this.lines[generatedLine - 1];
        if (!segments?.length) return null;
        let selected: MappingSegment | undefined;
        for (const segment of segments) {
            if (segment.generatedColumn > generatedColumn) break;
            selected = segment;
        }
        if (!selected) return null;
        const source = this.map.sources[selected.sourceIndex];
        if (source === undefined) return null;
        const name =
            selected.nameIndex === null
                ? null
                : (this.map.names?.[selected.nameIndex] ?? null);
        return {
            source: joinSource(this.map.sourceRoot, source),
            line: selected.originalLine + 1,
            column: selected.originalColumn + 1,
            name,
        };
    }

    private decodeMappings(mappings: string): MappingSegment[][] {
        let sourceIndex = 0;
        let originalLine = 0;
        let originalColumn = 0;
        let nameIndex = 0;
        return mappings.split(';').map((line) => {
            let generatedColumn = 0;
            const decoded: MappingSegment[] = [];
            for (const encoded of line.split(',')) {
                if (!encoded) continue;
                const values = decodeVlq(encoded);
                generatedColumn += values[0] ?? 0;
                if (values.length === 1) continue;
                if (values.length < 4)
                    throw new Error('Invalid Source Map mapping segment');
                sourceIndex += values[1];
                originalLine += values[2];
                originalColumn += values[3];
                if (values.length >= 5) nameIndex += values[4];
                decoded.push({
                    generatedColumn,
                    sourceIndex,
                    originalLine,
                    originalColumn,
                    nameIndex: values.length >= 5 ? nameIndex : null,
                });
            }
            return decoded;
        });
    }
}

export function parseSourceMap(content: string): ParsedSourceMap {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        throw new Error('Source map must be valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Source map must be a JSON object');
    return new ParsedSourceMap(parsed as RawSourceMap);
}
