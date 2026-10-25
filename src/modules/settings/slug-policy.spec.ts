import {
    DEFAULT_RESERVED_SLUGS,
    isReservedSlug,
    normalizeReservedSlugs,
} from './slug-policy';

describe('slug policy', () => {
    it('matches reserved names case-insensitively and ignores padding', () => {
        expect(isReservedSlug('ADMIN', ['admin'])).toBe(true);
        expect(isReservedSlug('  admin  ', ['admin'])).toBe(true);
        expect(isReservedSlug('acme', ['admin'])).toBe(false);
        expect(isReservedSlug('', ['admin'])).toBe(false);
    });

    it('normalizes stored values into a lowercase unique list', () => {
        expect(normalizeReservedSlugs([' Admin ', 'admin', 'api', 42])).toEqual(
            ['admin', 'api'],
        );
    });

    it('falls back to the built-in list for invalid stored values', () => {
        expect(normalizeReservedSlugs(undefined)).toEqual([
            ...DEFAULT_RESERVED_SLUGS,
        ]);
        expect(normalizeReservedSlugs('admin')).toEqual([
            ...DEFAULT_RESERVED_SLUGS,
        ]);
        expect(normalizeReservedSlugs([])).toEqual([...DEFAULT_RESERVED_SLUGS]);
    });

    it('keeps the built-in list lowercase and free of duplicates', () => {
        expect(new Set(DEFAULT_RESERVED_SLUGS).size).toBe(
            DEFAULT_RESERVED_SLUGS.length,
        );
        expect(
            DEFAULT_RESERVED_SLUGS.every((slug) => slug === slug.toLowerCase()),
        ).toBe(true);
        // 平台路由里最容易撞车的那几个必须在默认清单里
        for (const slug of ['admin', 'api', 'status', 'login', 'settings']) {
            expect(DEFAULT_RESERVED_SLUGS).toContain(slug);
        }
    });
});
