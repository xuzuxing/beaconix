import { BadRequestException, Injectable } from '@nestjs/common';
import type {
    ConditionNode,
    FieldMeta,
    RuleContext,
    RuleField,
    RuleNode,
} from './types';
import { FIELD_META, STATUS_CLASS_VALUES } from './types';

const MAX_DEPTH = 10;

/**
 * 纯函数的规则求值器：递归求值一棵规则树，并校验其结构合法性。
 * 没有任何 IO 依赖，便于单测。
 */
@Injectable()
export class RuleEvaluatorService {
    /** 递归求值。and 在首个 false 短路，or 在首个 true 短路。 */
    evaluate(node: RuleNode, ctx: RuleContext): boolean {
        if (node.type === 'condition') {
            return this.evaluateCondition(node, ctx);
        }

        return node.operator === 'and'
            ? node.children.every((child) => this.evaluate(child, ctx))
            : node.children.some((child) => this.evaluate(child, ctx));
    }

    private evaluateCondition(node: ConditionNode, ctx: RuleContext): boolean {
        const actual = ctx[node.field];
        if (actual === undefined || actual === null) return false;

        switch (node.operator) {
            case 'eq':
                return (
                    this.normalize(actual, node.field) ===
                    this.normalize(node.value, node.field)
                );
            case 'neq':
                return (
                    this.normalize(actual, node.field) !==
                    this.normalize(node.value, node.field)
                );
            case 'gt':
                return Number(actual) > Number(node.value);
            case 'gte':
                return Number(actual) >= Number(node.value);
            case 'lt':
                return Number(actual) < Number(node.value);
            case 'lte':
                return Number(actual) <= Number(node.value);
            case 'contains':
                return String(actual).includes(String(node.value));
            case 'in': {
                const arr = Array.isArray(node.value)
                    ? node.value
                    : String(node.value).split(',');
                return arr.map(String).includes(String(actual));
            }
            case 'not_in': {
                const arr = Array.isArray(node.value)
                    ? node.value
                    : String(node.value).split(',');
                return !arr.map(String).includes(String(actual));
            }
            case 'statusClass': {
                const classes = String(node.value)
                    .split(',')
                    .map((v) => Number(v.trim()));
                return classes.includes(Math.floor(Number(actual) / 100));
            }
            default:
                return false;
        }
    }

    /** 数值型字段统一按 number 比较，避免 JSON 字符串与 number 严格不等。 */
    private normalize(value: unknown, field: RuleField): unknown {
        if (field === 'success') return Boolean(value);
        if (
            field === 'latency' ||
            field === 'certDaysRemaining' ||
            field === 'statusCode'
        ) {
            return Number(value);
        }
        return String(value);
    }

    /** 从树里提取所有用到的字段名（写入 RuleGroup.fieldsUsed）。 */
    extractFields(node: RuleNode, acc = new Set<string>()): string[] {
        if (node.type === 'condition') {
            acc.add(node.field);
        } else {
            for (const child of node.children) this.extractFields(child, acc);
        }
        return [...acc];
    }

    /** 校验树结构（保存前调用），失败抛 400。 */
    validate(node: RuleNode, depth = 0): void {
        if (depth > MAX_DEPTH) {
            throw new BadRequestException(`规则树嵌套超过 ${MAX_DEPTH} 层`);
        }

        if (node.type === 'logic') {
            if (!['and', 'or'].includes(node.operator)) {
                throw new BadRequestException(
                    `逻辑组 ${node.id} 的 operator 非法`,
                );
            }
            if (node.children.length === 0) {
                throw new BadRequestException(`逻辑组 ${node.id} 不能为空`);
            }
            for (const child of node.children) this.validate(child, depth + 1);
            return;
        }

        if (node.type !== 'condition') {
            throw new BadRequestException(
                `未知节点类型 "${String((node as RuleNode).type)}"`,
            );
        }

        const meta = FIELD_META[node.field];
        if (!meta) {
            throw new BadRequestException(
                `条件 ${node.id} 的 field 非法: ${String(node.field)}`,
            );
        }
        if (!meta.operators.includes(node.operator)) {
            throw new BadRequestException(
                `条件 ${node.id} 的 operator "${node.operator}" 不适用于字段 "${node.field}"`,
            );
        }
        if (
            node.value === undefined ||
            node.value === null ||
            node.value === ''
        ) {
            throw new BadRequestException(`条件 ${node.id} 缺少 value`);
        }

        this.validateValue(node, meta);
    }

    /** 校验单个条件的 value 符合其字段/操作符的取值约束。 */
    private validateValue(node: ConditionNode, meta: FieldMeta): void {
        if (node.operator === 'statusClass') {
            const classes = String(node.value)
                .split(',')
                .map((v) => Number(v.trim()));
            if (classes.some((c) => !STATUS_CLASS_VALUES.includes(c))) {
                throw new BadRequestException(
                    `条件 ${node.id} 的 statusClass 取值须为 1-5 之一（1xx~5xx），收到: ${String(node.value)}`,
                );
            }
            return;
        }

        const values =
            node.operator === 'in' || node.operator === 'not_in'
                ? Array.isArray(node.value)
                    ? node.value
                    : String(node.value).split(',')
                : [node.value];

        for (const raw of values) {
            this.assertValueInRange(node, meta, raw);
        }
    }

    private assertValueInRange(
        node: ConditionNode,
        meta: FieldMeta,
        raw: unknown,
    ): void {
        if (meta.valueType === 'number') {
            const n = Number(raw);
            const c = meta.constraints ?? {};
            if (Number.isNaN(n)) {
                throw new BadRequestException(
                    `条件 ${node.id} 的 value 必须是数字: ${String(raw)}`,
                );
            }
            if (c.integer && !Number.isInteger(n)) {
                throw new BadRequestException(
                    `条件 ${node.id} 的 value 必须是整数: ${String(raw)}`,
                );
            }
            if (c.min !== undefined && n < c.min) {
                throw new BadRequestException(
                    `条件 ${node.id} 的 value 不能小于 ${c.min}: ${String(raw)}`,
                );
            }
            if (c.max !== undefined && n > c.max) {
                throw new BadRequestException(
                    `条件 ${node.id} 的 value 不能大于 ${c.max}: ${String(raw)}`,
                );
            }
            return;
        }

        if (meta.valueType === 'boolean') {
            if (typeof raw !== 'boolean') {
                throw new BadRequestException(
                    `条件 ${node.id} 的 value 必须是布尔值: ${String(raw)}`,
                );
            }
            return;
        }

        const c = meta.constraints ?? {};
        if (c.maxLength !== undefined && String(raw).length > c.maxLength) {
            throw new BadRequestException(
                `条件 ${node.id} 的 value 超过最大长度 ${c.maxLength}`,
            );
        }
    }
}
