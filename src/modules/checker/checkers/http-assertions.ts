import { parseJsonPointer } from '../../monitors/http-monitor-config';
import type { HttpMonitorConfig } from '../../monitors/http-monitor-config';
import type { HttpAssertionFailure, HttpAssertionResult } from './check-result';

function lookup(
    document: unknown,
    path: string,
): { exists: boolean; value?: unknown } {
    let value = document;
    for (const part of parseJsonPointer(path)) {
        if (
            value === null ||
            typeof value !== 'object' ||
            (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(part)) ||
            !Object.hasOwn(value, part)
        ) {
            return { exists: false };
        }
        value = (value as Record<string, unknown>)[part];
    }
    return { exists: true, value };
}

export function evaluateHttpAssertions(
    body: string,
    config: HttpMonitorConfig,
): { results: HttpAssertionResult[]; failure?: HttpAssertionFailure } {
    const results: HttpAssertionResult[] = [];
    if (config.keyword !== undefined) {
        const contains = body.includes(config.keyword);
        results.push({
            kind: 'keyword',
            passed: config.keywordMode === 'notContains' ? !contains : contains,
        });
    }
    if (config.jsonAssertions) {
        let document: unknown;
        try {
            document = JSON.parse(body);
        } catch {
            return { results, failure: 'INVALID_JSON' };
        }
        for (const [index, assertion] of config.jsonAssertions.entries()) {
            const actual = lookup(document, assertion.path);
            let passed: boolean;
            switch (assertion.operator) {
                case 'exists':
                    passed = actual.exists;
                    break;
                case 'notExists':
                    passed = !actual.exists;
                    break;
                case 'eq':
                    passed = actual.exists && actual.value === assertion.value;
                    break;
                case 'neq':
                    passed = actual.exists && actual.value !== assertion.value;
                    break;
            }
            results.push({ kind: 'json', index, passed });
        }
    }
    const failed = results.find((result) => !result.passed);
    return {
        results,
        ...(failed
            ? {
                  failure:
                      failed.kind === 'keyword'
                          ? ('KEYWORD' as const)
                          : ('JSON_VALUE' as const),
              }
            : {}),
    };
}
