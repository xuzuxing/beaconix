import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../infra/database/prisma.service';
import { PlanEntity } from '../../billing/plan/entities';
import {
    CreatePlanDto,
    CreatePlanTermDto,
    normalizePlanCode,
    UpdatePlanDto,
} from './dto';

/** The fallback plan every tenant without a subscription resolves to. */
const FALLBACK_PLAN_CODE = 'FREE';

/** Canonical order of a plan's terms in every response. */
const TERM_ORDER: Prisma.PlanTermOrderByWithRelationInput[] = [
    { sortOrder: 'asc' },
    { price: 'asc' },
];

interface NormalizedTerm {
    cycle: CreatePlanTermDto['cycle'];
    durationDays: number;
    price: number;
    enabled: boolean;
    sortOrder: number;
    /** 小程序虚拟支付道具 ID；null = 该档位不接受虚拟支付下单。 */
    wechatProductId: string | null;
}

/**
 * SUPER_ADMIN CRUD over the plan catalog.
 *
 * A plan sells one or more cycle terms (monthly / quarterly / yearly), each
 * with its own price. `Plan.price` / `Plan.durationDays` mirror the cheapest
 * enabled term — this service is the only writer, so the public catalog keeps
 * exposing a single "from" price without loading terms.
 *
 * Quota changes take effect immediately: `QuotaService` and
 * `EffectivePlanService` read the plan row on every check, there is no cache
 * and no per-subscription snapshot of the limits.
 */
@Injectable()
export class AdminPlansService {
    constructor(private readonly prisma: PrismaService) {}

    /** Every plan, disabled ones included, in catalog order. */
    async findAll(): Promise<PlanEntity[]> {
        const plans = await this.prisma.plan.findMany({
            orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
            include: { terms: { orderBy: TERM_ORDER } },
        });

        return plans.map((plan) => new PlanEntity(plan));
    }

    async findOne(planId: string): Promise<PlanEntity> {
        const plan = await this.prisma.plan.findUnique({
            where: { id: planId },
            include: { terms: { orderBy: TERM_ORDER } },
        });
        if (!plan) throw new NotFoundException('Plan not found');
        return new PlanEntity(plan);
    }

    async create(dto: CreatePlanDto): Promise<PlanEntity> {
        const terms = this.normalizeTerms(dto.terms);
        const defaultTerm = this.resolveDefaultTerm(terms);

        try {
            const plan = await this.prisma.plan.create({
                data: {
                    ...this.planFields(dto),
                    name: dto.name,
                    code: normalizePlanCode(dto.code),
                    price: defaultTerm.price,
                    durationDays: defaultTerm.durationDays,
                    terms: {
                        create: terms.map((term) => ({
                            cycle: term.cycle,
                            durationDays: term.durationDays,
                            price: term.price,
                            enabled: term.enabled,
                            sortOrder: term.sortOrder,
                            wechatProductId: term.wechatProductId,
                        })),
                    },
                },
                include: { terms: { orderBy: TERM_ORDER } },
            });

            return new PlanEntity(plan);
        } catch (error) {
            this.rethrowKnownConstraint(error);
            throw error;
        }
    }

    /**
     * Partial update. Omitted keys keep their value; `description: null` clears
     * the column. `code` is immutable — echoing the stored value is accepted so
     * clients can PATCH a whole form back.
     *
     * `terms` replaces the whole cycle set: a cycle that is sent is upserted, a
     * cycle that disappears is disabled (deleted when no order references it),
     * so removing a cycle never breaks past orders.
     */
    async update(planId: string, dto: UpdatePlanDto): Promise<PlanEntity> {
        const current = await this.prisma.plan.findUnique({
            where: { id: planId },
            select: { id: true, code: true },
        });
        if (!current) throw new NotFoundException('Plan not found');

        if (
            dto.code !== undefined &&
            normalizePlanCode(dto.code) !== current.code
        ) {
            throw new BadRequestException({
                code: 'PLAN_CODE_IMMUTABLE',
                message: 'plan code is immutable',
            });
        }

        try {
            const plan = await this.prisma.$transaction(async (tx) => {
                if (dto.terms !== undefined) {
                    await this.syncTerms(
                        tx,
                        planId,
                        this.normalizeTerms(dto.terms),
                    );
                }

                const terms = await tx.planTerm.findMany({
                    where: { planId },
                });
                const defaultTerm = this.resolveDefaultTerm(terms);

                return tx.plan.update({
                    where: { id: planId },
                    data: {
                        ...this.planFields(dto),
                        price: defaultTerm.price,
                        durationDays: defaultTerm.durationDays,
                    },
                    include: { terms: { orderBy: TERM_ORDER } },
                });
            });

            return new PlanEntity(plan);
        } catch (error) {
            this.rethrowKnownConstraint(error);
            throw error;
        }
    }

    /**
     * Hard-deletes an unreferenced plan. Plans referenced by orders or
     * subscriptions must be disabled instead, so billing history stays
     * readable. The FREE fallback plan can never be deleted.
     */
    async remove(planId: string): Promise<void> {
        const plan = await this.prisma.plan.findUnique({
            where: { id: planId },
            select: { id: true, code: true },
        });
        if (!plan) throw new NotFoundException('Plan not found');

        if (plan.code === FALLBACK_PLAN_CODE) {
            throw new ConflictException({
                code: 'PLAN_PROTECTED',
                message:
                    'The FREE plan is the fallback plan for tenants without a subscription and cannot be deleted; disable it instead',
            });
        }

        const [orders, subscriptions] = await Promise.all([
            this.prisma.order.count({ where: { planId } }),
            this.prisma.subscription.count({ where: { planId } }),
        ]);

        if (orders || subscriptions) {
            throw new ConflictException({
                code: 'PLAN_IN_USE',
                message: `Plan is still referenced by ${orders} order(s) and ${subscriptions} subscription(s); disable it instead of deleting`,
            });
        }

        try {
            await this.prisma.plan.delete({ where: { id: planId } });
        } catch (error) {
            this.rethrowKnownConstraint(error);
            throw error;
        }
    }

    // -- Helpers ---------------------------------------------------------

    /** Plan columns shared by create and update (terms/price excluded). */
    private planFields(dto: CreatePlanDto | UpdatePlanDto) {
        return {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.description !== undefined
                ? { description: dto.description }
                : {}),
            ...(dto.sortOrder !== undefined
                ? { sortOrder: dto.sortOrder }
                : {}),
            ...(dto.maxMonitors !== undefined
                ? { maxMonitors: dto.maxMonitors }
                : {}),
            ...(dto.maxProbes !== undefined
                ? { maxProbes: dto.maxProbes }
                : {}),
            ...(dto.maxProbesPerMonitor !== undefined
                ? { maxProbesPerMonitor: dto.maxProbesPerMonitor }
                : {}),
            ...(dto.maxApiKeys !== undefined
                ? { maxApiKeys: dto.maxApiKeys }
                : {}),
            ...(dto.maxMembers !== undefined
                ? { maxMembers: dto.maxMembers }
                : {}),
            ...(dto.maxChannels !== undefined
                ? { maxChannels: dto.maxChannels }
                : {}),
            ...(dto.minInterval !== undefined
                ? { minInterval: dto.minInterval }
                : {}),
            ...(dto.allowTenantProbe !== undefined
                ? { allowTenantProbe: dto.allowTenantProbe }
                : {}),
            ...(dto.allowStatusPage !== undefined
                ? { allowStatusPage: dto.allowStatusPage }
                : {}),
            ...(dto.allowedMonitorTypes !== undefined
                ? {
                      allowedMonitorTypes: [
                          ...new Set(dto.allowedMonitorTypes),
                      ],
                  }
                : {}),
            ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        };
    }

    private normalizeTerms(terms: CreatePlanTermDto[]): NormalizedTerm[] {
        return terms.map((term) => ({
            cycle: term.cycle,
            durationDays: term.durationDays,
            price: term.price,
            enabled: term.enabled ?? true,
            sortOrder: term.sortOrder ?? 0,
            wechatProductId: term.wechatProductId?.trim() || null,
        }));
    }

    /**
     * The plan-level price/duration mirror is the cheapest enabled term, which
     * is also the default cycle a buyer gets when they do not pick one. A plan
     * always needs at least one enabled term or it cannot be purchased at all.
     */
    private resolveDefaultTerm<
        T extends { enabled: boolean; price: number; sortOrder: number },
    >(terms: T[]): T {
        const enabled = terms
            .filter((term) => term.enabled)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.price - b.price);

        if (enabled.length === 0) {
            throw new BadRequestException({
                code: 'PLAN_TERM_REQUIRED',
                message:
                    'A plan needs at least one enabled cycle term; disable the plan itself to stop selling it',
            });
        }

        return enabled[0];
    }

    /**
     * Applies a full cycle set. Upserts the cycles that were sent; cycles that
     * vanished are disabled when an order references them (history keeps its
     * term) and deleted otherwise.
     */
    private async syncTerms(
        tx: Prisma.TransactionClient,
        planId: string,
        terms: NormalizedTerm[],
    ): Promise<void> {
        const existing = await tx.planTerm.findMany({
            where: { planId },
            select: { id: true, cycle: true },
        });
        const existingByCycle = new Map(
            existing.map((term) => [term.cycle, term]),
        );

        for (const term of terms) {
            const current = existingByCycle.get(term.cycle);

            if (current) {
                await tx.planTerm.update({
                    where: { id: current.id },
                    data: {
                        durationDays: term.durationDays,
                        price: term.price,
                        enabled: term.enabled,
                        sortOrder: term.sortOrder,
                        wechatProductId: term.wechatProductId,
                    },
                });
                continue;
            }

            await tx.planTerm.create({
                data: {
                    planId,
                    cycle: term.cycle,
                    durationDays: term.durationDays,
                    price: term.price,
                    enabled: term.enabled,
                    sortOrder: term.sortOrder,
                    wechatProductId: term.wechatProductId,
                },
            });
        }

        const keptCycles = new Set(terms.map((term) => term.cycle));

        for (const stale of existing) {
            if (keptCycles.has(stale.cycle)) continue;

            const referenced = await tx.order.count({
                where: { termId: stale.id },
            });

            if (referenced) {
                await tx.planTerm.update({
                    where: { id: stale.id },
                    data: { enabled: false },
                });
            } else {
                await tx.planTerm.delete({ where: { id: stale.id } });
            }
        }
    }

    /**
     * Maps the constraints the admin catalog can trip into actionable errors:
     * a duplicate code is a 409 (the `@unique` index is the only race-proof
     * gate), a vanished row is a 404, an FK block on delete is a 409.
     */
    private rethrowKnownConstraint(error: unknown): void {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return;

        if (error.code === 'P2002') {
            throw new ConflictException({
                code: 'PLAN_CODE_TAKEN',
                message:
                    'A plan with this code (or this cycle within the plan) already exists',
            });
        }

        if (error.code === 'P2025') {
            throw new NotFoundException('Plan not found');
        }

        if (error.code === 'P2003') {
            throw new ConflictException({
                code: 'PLAN_IN_USE',
                message:
                    'Plan is still referenced by orders or subscriptions; disable it instead of deleting',
            });
        }
    }
}
