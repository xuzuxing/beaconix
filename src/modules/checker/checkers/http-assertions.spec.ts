import { evaluateHttpAssertions } from './http-assertions';
import { validateHttpMonitorConfig } from '../../monitors/http-monitor-config';

function evaluate(body: string, config: unknown) {
    return evaluateHttpAssertions(body, validateHttpMonitorConfig(config));
}

describe('HTTP assertions', () => {
    it('matches literal case-sensitive text beyond the legacy prefix', () => {
        expect(
            evaluate('x'.repeat(600) + 'healthy', { keyword: 'healthy' }),
        ).toEqual({
            results: [{ kind: 'keyword', passed: true }],
        });
        expect(evaluate('HEALTHY', { keyword: 'healthy' }).failure).toBe(
            'KEYWORD',
        );
        expect(evaluate('anything', { keyword: '.*' }).failure).toBe('KEYWORD');
        expect(
            evaluate('healthy', {
                keyword: 'error',
                keywordMode: 'notContains',
            }).failure,
        ).toBeUndefined();
        expect(
            evaluate('error', { keyword: 'error', keywordMode: 'notContains' })
                .failure,
        ).toBe('KEYWORD');
    });

    it('combines assertions with AND and distinguishes absence from null', () => {
        expect(
            evaluate('{"status":"ok","nullable":null,"count":3}', {
                keyword: '"status"',
                jsonAssertions: [
                    { path: '/status', operator: 'eq', value: 'ok' },
                    { path: '/nullable', operator: 'exists' },
                    { path: '/nullable', operator: 'eq', value: null },
                    { path: '/missing', operator: 'notExists' },
                    { path: '/count', operator: 'neq', value: '3' },
                ],
            }),
        ).toEqual({
            results: [
                { kind: 'keyword', passed: true },
                ...Array.from({ length: 5 }, (_, index) => ({
                    kind: 'json',
                    index,
                    passed: true,
                })),
            ],
        });
        expect(
            evaluate('{"status":"ok"}', {
                jsonAssertions: [
                    { path: '/status', operator: 'eq', value: 'ok' },
                    { path: '/status', operator: 'eq', value: 'bad' },
                ],
            }).failure,
        ).toBe('JSON_VALUE');
    });

    it.each(['eq', 'neq', 'exists'])('missing paths fail %s', (operator) => {
        const assertion =
            operator === 'exists'
                ? { path: '/missing', operator }
                : { path: '/missing', operator, value: null };
        expect(evaluate('{}', { jsonAssertions: [assertion] }).failure).toBe(
            'JSON_VALUE',
        );
    });

    it('traverses own properties and canonical array indexes only', () => {
        const body = '{"a/b":{"~key":[{"status":true}]},"":0}';
        expect(
            evaluate(body, {
                jsonAssertions: [
                    {
                        path: '/a~1b/~0key/0/status',
                        operator: 'eq',
                        value: true,
                    },
                    { path: '/', operator: 'eq', value: 0 },
                    { path: '/toString', operator: 'notExists' },
                    { path: '/a~1b/~0key/length', operator: 'notExists' },
                    { path: '/a~1b/~0key/00', operator: 'notExists' },
                    { path: '/a~1b/~0key/4', operator: 'notExists' },
                ],
            }).failure,
        ).toBeUndefined();
    });

    it.each([
        ['null', null],
        ['true', true],
        ['3', 3],
        ['"ok"', 'ok'],
    ])('allows scalar root documents %s', (body, value) => {
        expect(
            evaluate(String(body), {
                jsonAssertions: [{ path: '', operator: 'eq', value }],
            }).failure,
        ).toBeUndefined();
    });

    it('reports invalid JSON without echoing response or parser errors', () => {
        const result = evaluate('private-response-invalid-json', {
            jsonAssertions: [{ path: '/status', operator: 'exists' }],
        });
        expect(result).toEqual({ results: [], failure: 'INVALID_JSON' });
        expect(JSON.stringify(result)).not.toContain('private-response');
    });
});
