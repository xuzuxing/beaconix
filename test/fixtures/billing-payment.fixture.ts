import { PaymentService } from '../../src/modules/billing/payment/payment.service';
import { OrderService } from '../../src/modules/billing/order/order.service';
import { RefundService } from '../../src/modules/billing/refund/refund.service';
import { DEFAULT_REFUND_RUNTIME_CONFIG } from '../../src/modules/billing/refund/refund-config.service';

/** In-memory transactional fixture; never connects to PostgreSQL or a channel. */
export function billingPaymentFixture() {
    let tables: Record<string, any[]> = {
        order: [],
        payment: [],
        paymentAttempt: [],
        subscription: [],
        subscriptionEntitlement: [],
        refund: [],
        plan: [
            {
                id: 'c123456789012345678901234',
                code: 'PRO',
                name: 'Pro',
                sortOrder: 1,
                enabled: true,
                terms: [
                    {
                        id: 'monthly',
                        enabled: true,
                        cycle: 'MONTHLY',
                        price: 2900,
                        durationDays: 30,
                    },
                ],
            },
        ],
    };
    let sequence = 0;
    const copy = <T>(value: T): T => structuredClone(value);
    function matches(row: any, where: any = {}): boolean {
        return Object.entries(where).every(([key, expected]: [string, any]) => {
            if (expected === undefined) return true;
            if (key === 'OR')
                return expected.some((clause) => matches(row, clause));
            if (key === 'AND')
                return expected.every((clause) => matches(row, clause));
            if (key === 'order')
                return matches(
                    tables.order.find((o) => o.id === row.orderId),
                    expected,
                );
            if (key === 'plan')
                return matches(
                    tables.plan.find((p) => p.id === row.planId),
                    expected,
                );
            const actual = row?.[key] ?? null;
            if (expected instanceof Date)
                return actual instanceof Date && +actual === +expected;
            if (
                expected === null ||
                typeof expected !== 'object' ||
                expected instanceof Date
            )
                return actual === expected;
            return Object.entries(expected).every(
                ([op, value]: [string, any]) => {
                    if (op === 'in') return value.includes(actual);
                    if (op === 'notIn') return !value.includes(actual);
                    if (op === 'not') return actual !== value;
                    if (op === 'gt') return actual !== null && actual > value;
                    if (op === 'gte') return actual !== null && actual >= value;
                    if (op === 'lt') return actual !== null && actual < value;
                    if (op === 'lte') return actual !== null && actual <= value;
                    throw new Error(`Unsupported fixture filter ${op}`);
                },
            );
        });
    }
    function patch(row: any, data: any) {
        for (const [key, value] of Object.entries(data)) {
            row[key] =
                value && typeof value === 'object' && 'increment' in value
                    ? Number(row[key] ?? 0) + Number(value.increment)
                    : copy(value);
        }
        row.updatedAt = new Date();
        return row;
    }
    const prisma: any = { $queryRaw: jest.fn().mockResolvedValue([]) };
    for (const name of Object.keys(tables)) {
        function decorate(row: any, args: any) {
            if (!row) return null;
            const result = copy(row);
            if (args.include?.order)
                result.order = copy(
                    tables.order.find((o) => o.id === row.orderId),
                );
            if (args.include?.plan)
                result.plan = copy(
                    tables.plan.find((p) => p.id === row.planId),
                );
            if (args.include?.subscription) {
                result.subscription = copy(
                    tables.subscription.find((s) =>
                        name === 'subscriptionEntitlement'
                            ? s.id === row.subscriptionId
                            : s.orderId === row.id,
                    ) ?? null,
                );
            }
            return result;
        }
        const delegate: any = {};
        delegate.findUnique = jest.fn((args) =>
            Promise.resolve().then(() =>
                decorate(
                    tables[name].find((row) => matches(row, args.where)),
                    args,
                ),
            ),
        );
        delegate.findFirst = jest.fn(
            async (args) =>
                (await delegate.findMany({ ...args, take: 1 }))[0] ?? null,
        );
        delegate.findUniqueOrThrow = jest.fn(async (args) => {
            const row = await delegate.findUnique(args);
            if (!row) throw new Error(`${name} missing`);
            return row;
        });
        delegate.findMany = jest.fn((args = {}) =>
            Promise.resolve().then(() => {
                const rows = tables[name].filter((row) =>
                    matches(row, args.where),
                );
                const ordering = args.orderBy
                    ? Array.isArray(args.orderBy)
                        ? args.orderBy
                        : [args.orderBy]
                    : [];
                rows.sort((a, b) => {
                    for (const clause of ordering) {
                        const [key, direction] = Object.entries(clause)[0] as [
                            string,
                            string,
                        ];
                        if (a[key] < b[key])
                            return direction === 'asc' ? -1 : 1;
                        if (a[key] > b[key])
                            return direction === 'asc' ? 1 : -1;
                    }
                    return 0;
                });
                return rows
                    .slice(0, args.take ?? Infinity)
                    .map((row) => decorate(row, args));
            }),
        );
        delegate.count = jest.fn(
            async (args = {}) => (await delegate.findMany(args)).length,
        );
        delegate.create = jest.fn((args) =>
            Promise.resolve().then(() => {
                const row = {
                    id: `${name}-${++sequence}`,
                    status: 'PENDING',
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    refundedAmount: 0,
                    closePending: false,
                    lastCheckedAt: null,
                    reconcileLeaseToken: null,
                    reconcileLeaseUntil: null,
                    submittedAt: null,
                    ...(name === 'subscriptionEntitlement'
                        ? { consumedMs: 0n }
                        : {}),
                    pausedAt: null,
                    pausedRemainingDays: null,
                    entitlementsTracked: false,
                    ...copy(args.data),
                };
                tables[name].push(row);
                return decorate(row, args);
            }),
        );
        delegate.update = jest.fn((args) =>
            Promise.resolve().then(() => {
                const row = tables[name].find((r) => matches(r, args.where));
                if (!row) throw new Error(`${name} missing`);
                return decorate(patch(row, args.data), args);
            }),
        );
        delegate.updateMany = jest.fn((args) =>
            Promise.resolve().then(() => {
                const rows = tables[name].filter((row) =>
                    matches(row, args.where),
                );
                rows.forEach((row) => patch(row, args.data));
                return { count: rows.length };
            }),
        );
        delegate.upsert = jest.fn((args) =>
            Promise.resolve().then(() =>
                tables[name].some((row) => matches(row, args.where))
                    ? delegate.update({ ...args, data: args.update })
                    : delegate.create({ ...args, data: args.create }),
            ),
        );
        prisma[name] = delegate;
    }
    prisma.membership = {
        findUnique: jest.fn(({ where }) =>
            Promise.resolve().then(() =>
                where.userId_organizationId.userId === 'buyer' &&
                where.userId_organizationId.organizationId === 'org'
                    ? { role: 'OWNER' }
                    : null,
            ),
        ),
    };
    prisma.user = {
        findFirst: jest.fn().mockResolvedValue({
            id: 'buyer',
            email: 'buyer@example.com',
            globalRole: 'USER',
        }),
    };
    prisma.organization = {
        findFirst: jest.fn(({ where }) =>
            Promise.resolve().then(() =>
                where.id === 'org' ? { id: 'org' } : null,
            ),
        ),
    };
    prisma.label = { findUnique: jest.fn().mockResolvedValue(null) };
    // Serial transactions plus rollback exercise service state transitions, not PG lock semantics.
    let tail: Promise<unknown> = Promise.resolve();
    prisma.$transaction = jest.fn((work) => {
        const result = tail.then(async () => {
            const before = copy(tables);
            try {
                return await work(prisma);
            } catch (error) {
                tables = before;
                throw error;
            }
        });
        tail = result.catch(() => undefined);
        return result;
    });
    const provider = {
        createPayment: jest
            .fn()
            .mockResolvedValue({ package: 'prepay_id=fixture' }),
        verifyCallback: jest.fn((raw) =>
            Promise.resolve().then(() => JSON.parse(raw)),
        ),
        queryPayment: jest.fn((outTradeNo) =>
            Promise.resolve().then(() => ({
                out_trade_no: outTradeNo,
                transaction_id: '',
                trade_state: 'NOTPAY',
            })),
        ),
        closePayment: jest.fn().mockResolvedValue(undefined),
        refund: jest.fn().mockResolvedValue({ status: 'PROCESSING' }),
        queryRefund: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
        parseRefundCallback: jest.fn((raw) =>
            Promise.resolve().then(() => JSON.parse(raw)),
        ),
    };
    const providers: any = {
        get: jest.fn().mockReturnValue(provider),
        getRefundProvider: jest.fn().mockReturnValue(provider),
    };
    const notifications: any = {
        publish: jest.fn().mockResolvedValue(undefined),
        organizationRecipients: jest.fn().mockResolvedValue(['admin']),
    };
    const plans: any = {
        getEffectivePlanInTransaction: jest.fn().mockResolvedValue(null),
    };
    const payments = new PaymentService(
        prisma,
        providers,
        notifications,
        plans,
    );
    const orders = new OrderService(prisma, payments);
    const config: any = {
        config: jest.fn().mockResolvedValue({
            ...DEFAULT_REFUND_RUNTIME_CONFIG,
            enabled: true,
            userSelfService: true,
            autoApproveLimit: 10000,
        }),
    };
    const refunds = new RefundService(
        prisma,
        providers,
        notifications,
        plans,
        config,
    );
    return {
        prisma,
        provider,
        providers,
        notifications,
        plans,
        payments,
        orders,
        refunds,
        config,
        rows: (name: string) => tables[name],
        newOrder: () =>
            orders.create('org', 'buyer', {
                planId: 'c123456789012345678901234',
            }),
        paid: (outTradeNo: string, overrides: any = {}) => ({
            out_trade_no: outTradeNo,
            transaction_id: `tx-${outTradeNo}`,
            trade_state: 'SUCCESS',
            amount: { total: 2900 },
            ...overrides,
        }),
    };
}
