import { BadRequestException } from '@nestjs/common';
import { RuleEvaluatorService } from './rule-evaluator.service';
import type { ConditionNode, LogicNode, RuleNode } from './types';

const service = new RuleEvaluatorService();

const cond = (partial: Partial<ConditionNode>): ConditionNode => ({
    type: 'condition',
    id: 'c1',
    field: 'latency',
    operator: 'gt',
    value: 100,
    ...partial,
});

describe('RuleEvaluatorService.evaluate', () => {
    it('evaluates a single condition', () => {
        const node = cond({ field: 'latency', operator: 'gt', value: 100 });
        expect(service.evaluate(node, { latency: 150 })).toBe(true);
        expect(service.evaluate(node, { latency: 50 })).toBe(false);
    });

    it('returns false when the context has no value for the field', () => {
        expect(
            service.evaluate(
                cond({ field: 'latency', operator: 'gt', value: 100 }),
                {},
            ),
        ).toBe(false);
    });

    it('combines children with and / or', () => {
        const children = [
            cond({ id: 'a', field: 'success', operator: 'eq', value: false }),
            cond({ id: 'b', field: 'latency', operator: 'gte', value: 100 }),
        ];
        const and: LogicNode = {
            type: 'logic',
            id: 'l1',
            operator: 'and',
            children,
        };
        const or: LogicNode = {
            type: 'logic',
            id: 'l2',
            operator: 'or',
            children,
        };

        expect(service.evaluate(and, { success: false, latency: 200 })).toBe(
            true,
        );
        expect(service.evaluate(and, { success: true, latency: 200 })).toBe(
            false,
        );
        expect(service.evaluate(or, { success: true, latency: 200 })).toBe(
            true,
        );
        expect(service.evaluate(or, { success: true, latency: 10 })).toBe(
            false,
        );
    });

    it('short-circuits and when a child is false', () => {
        const and: LogicNode = {
            type: 'logic',
            id: 'l1',
            operator: 'and',
            children: [
                cond({
                    id: 'a',
                    field: 'success',
                    operator: 'eq',
                    value: false,
                }),
                cond({ id: 'b', field: 'latency', operator: 'gt', value: 100 }),
            ],
        };
        // success=true makes the first child false; latency is absent but that
        // must not matter (the second child still evaluates, returning false).
        expect(service.evaluate(and, { success: true })).toBe(false);
    });

    it('coerces numeric eq so JSON strings match numbers', () => {
        expect(
            service.evaluate(
                cond({ field: 'latency', operator: 'eq', value: '150' }),
                {
                    latency: 150,
                },
            ),
        ).toBe(true);
    });

    it('supports in / not_in / contains / statusClass / certDaysRemaining', () => {
        expect(
            service.evaluate(
                cond({ field: 'latency', operator: 'in', value: '100,200' }),
                {
                    latency: 200,
                },
            ),
        ).toBe(true);
        expect(
            service.evaluate(
                cond({
                    field: 'latency',
                    operator: 'not_in',
                    value: [100, 200],
                }),
                {
                    latency: 300,
                },
            ),
        ).toBe(true);
        expect(
            service.evaluate(
                cond({
                    field: 'bodyContains',
                    operator: 'contains',
                    value: 'ok',
                }),
                { bodyContains: 'all ok' },
            ),
        ).toBe(true);
        expect(
            service.evaluate(
                cond({
                    field: 'statusCode',
                    operator: 'statusClass',
                    value: '4,5',
                }),
                { statusCode: 503 },
            ),
        ).toBe(true);
        expect(
            service.evaluate(
                cond({
                    field: 'statusCode',
                    operator: 'statusClass',
                    value: '2',
                }),
                { statusCode: 503 },
            ),
        ).toBe(false);
        expect(
            service.evaluate(
                cond({
                    field: 'certDaysRemaining',
                    operator: 'lte',
                    value: 30,
                }),
                { certDaysRemaining: 20 },
            ),
        ).toBe(true);
    });
});

describe('RuleEvaluatorService.extractFields', () => {
    it('collects the fields used across the tree', () => {
        const tree: LogicNode = {
            type: 'logic',
            id: 'l1',
            operator: 'and',
            children: [
                cond({ id: 'a', field: 'latency' }),
                cond({ id: 'b', field: 'certDaysRemaining' }),
                cond({ id: 'c', field: 'latency' }),
            ],
        };

        expect(service.extractFields(tree).sort()).toEqual([
            'certDaysRemaining',
            'latency',
        ]);
    });
});

describe('RuleEvaluatorService.validate', () => {
    it('accepts a valid tree', () => {
        const tree: LogicNode = {
            type: 'logic',
            id: 'l1',
            operator: 'and',
            children: [
                cond({ id: 'a', field: 'latency', operator: 'gt', value: 100 }),
            ],
        };
        expect(() => service.validate(tree)).not.toThrow();
    });

    it('rejects an empty logic group', () => {
        expect(() =>
            service.validate({
                type: 'logic',
                id: 'l1',
                operator: 'and',
                children: [],
            }),
        ).toThrow(BadRequestException);
    });

    it('rejects an operator not allowed for the field', () => {
        expect(() =>
            service.validate(
                cond({ field: 'success', operator: 'gt', value: 1 }),
            ),
        ).toThrow(BadRequestException);
    });

    it('rejects an out-of-range value', () => {
        expect(() =>
            service.validate(
                cond({ field: 'statusCode', operator: 'eq', value: 700 }),
            ),
        ).toThrow(BadRequestException);
        expect(() =>
            service.validate(
                cond({ field: 'latency', operator: 'gt', value: -5 }),
            ),
        ).toThrow(BadRequestException);
    });

    it('rejects a statusClass value outside 1-5', () => {
        expect(() =>
            service.validate(
                cond({
                    field: 'statusCode',
                    operator: 'statusClass',
                    value: '6',
                }),
            ),
        ).toThrow(BadRequestException);
    });

    it('rejects nesting deeper than the limit', () => {
        let node: RuleNode = cond({
            id: 'leaf',
            field: 'latency',
            operator: 'gt',
            value: 1,
        });
        for (let i = 0; i < 12; i += 1) {
            node = {
                type: 'logic',
                id: `l${i}`,
                operator: 'and',
                children: [node],
            };
        }
        expect(() => service.validate(node)).toThrow(BadRequestException);
    });
});
