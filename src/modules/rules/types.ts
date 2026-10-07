/**
 * 嵌套规则引擎的类型定义与字段元数据。
 *
 * 规则树（RuleNode）存 RuleGroup.tree（JSON）。FIELD_META 是「字段 × 操作符 ×
 * 取值约束 × 默认值」的唯一事实源：后端用它做校验，前端编辑器通过 GET /rule-meta
 * 拉同一份数据驱动渲染。
 */

// 核心字段：检测器一贯提供
export type CoreRuleField = 'success' | 'latency' | 'certDaysRemaining';

// 扩展字段：需要检测器额外采集（实际状态码、响应体片段）
export type ExtendedRuleField = 'statusCode' | 'bodyContains';

export type RuleField = CoreRuleField | ExtendedRuleField;

export type RuleOperator =
    | 'eq'
    | 'neq'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'in'
    | 'not_in'
    | 'contains'
    | 'statusClass';

export interface ConditionNode {
    type: 'condition';
    id: string;
    field: RuleField;
    operator: RuleOperator;
    value: unknown;
}

export interface LogicNode {
    type: 'logic';
    id: string;
    operator: 'and' | 'or';
    children: RuleNode[];
}

export type RuleNode = ConditionNode | LogicNode;

/** 求值上下文：来自聚合后的 CheckResult。 */
export interface RuleContext {
    success?: boolean;
    latency?: number;
    certDaysRemaining?: number;
    statusCode?: number;
    bodyContains?: string;
}

/** 单个规则字段的元数据。 */
export interface FieldMeta {
    /** value 的语义类型，前端据此渲染输入控件 */
    valueType: 'boolean' | 'number' | 'string';
    /** 该字段允许的操作符 */
    operators: RuleOperator[];
    /** value 取值约束（保存前的校验依据） */
    constraints?: {
        min?: number;
        max?: number;
        integer?: boolean;
        maxLength?: number;
    };
    /** 编辑器新增条件时的默认值 */
    default: { operator: RuleOperator; value: unknown };
}

export const FIELD_META: Record<RuleField, FieldMeta> = {
    success: {
        valueType: 'boolean',
        operators: ['eq', 'neq'],
        default: { operator: 'eq', value: true },
    },
    latency: {
        valueType: 'number',
        operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in'],
        constraints: { min: 0, integer: true },
        default: { operator: 'gt', value: 1000 },
    },
    certDaysRemaining: {
        valueType: 'number',
        operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in'],
        constraints: { min: -3650, integer: true }, // 已过期为负
        default: { operator: 'lte', value: 30 },
    },
    statusCode: {
        valueType: 'number',
        operators: [
            'eq',
            'neq',
            'gt',
            'gte',
            'lt',
            'lte',
            'in',
            'not_in',
            'statusClass',
        ],
        constraints: { min: 100, max: 599, integer: true },
        default: { operator: 'eq', value: 200 },
    },
    bodyContains: {
        valueType: 'string',
        operators: ['eq', 'neq', 'contains', 'in', 'not_in'],
        constraints: { maxLength: 512 },
        default: { operator: 'contains', value: '' },
    },
};

/** 由 FIELD_META 派生的全量字段/操作符列表。 */
export const RULE_FIELDS = Object.keys(FIELD_META) as RuleField[];
export const RULE_OPERATORS = [
    ...new Set(Object.values(FIELD_META).flatMap((m) => m.operators)),
] as RuleOperator[];

/** statusClass 的合法取值：HTTP 状态码类别 1-5（对应 1xx~5xx）。 */
export const STATUS_CLASS_VALUES: readonly number[] = [1, 2, 3, 4, 5];
