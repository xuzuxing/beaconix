import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { RefundStatus } from '../../../generated/prisma/enums';
import { PrismaService } from '../../../infra/database/prisma.service';
import { RefundService } from '../../billing/refund/refund.service';
import {
    CreateAdminRefundDto,
    QueryAdminRefundsDto,
    QueryAdminRefundStatsDto,
} from './dto';
import { AdminRefundEntity } from './entities';

/** 对账报表的返回结构（金额单位：分）。 */
export interface RefundStats {
    total: { count: number; amount: number; settledAmount: number };
    byStatus: Array<{ status: string; count: number; amount: number }>;
    byChannel: Array<{ channel: string; count: number; amount: number }>;
    byPolicy: Array<{ policyCode: string; count: number; amount: number }>;
    failures: Array<{ reason: string; count: number }>;
}

/** 列表与详情都要带订单号，表格不需要二次查询。 */
const refundInclude = {
    order: { select: { orderNo: true } },
} as const;

type AdminRefundRow = Prisma.RefundGetPayload<{
    include: typeof refundInclude;
}>;

/**
 * 后台退款：查询、发起、重试、关闭。
 *
 * 真正的退款逻辑全在 `RefundService`（同一套规则也要给 P1 的用户自助用），
 * 这里只做跨租户查询与把 `RefundModel` 扁平成列表行。
 */
@Injectable()
export class AdminRefundsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly refunds: RefundService,
    ) {}

    async findAll(dto: QueryAdminRefundsDto) {
        const {
            organizationId,
            orderId,
            channel,
            status,
            refundNo,
            from,
            to,
            page = 1,
            limit = 25,
        } = dto;

        const where: Prisma.RefundWhereInput = {};

        if (organizationId) where.organizationId = organizationId;
        if (orderId) where.orderId = orderId;
        if (channel) where.channel = channel;
        if (status) where.status = status;
        if (refundNo) where.refundNo = refundNo;

        if (from || to) {
            where.createdAt = {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
            };
        }

        const [items, total] = await Promise.all([
            this.prisma.refund.findMany({
                where,
                include: refundInclude,
                orderBy: { createdAt: 'desc' },
                take: limit,
                skip: (page - 1) * limit,
            }),
            this.prisma.refund.count({ where }),
        ]);

        return {
            items: items.map((refund) => this.toEntity(refund)),
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        };
    }

    async findOne(id: string): Promise<AdminRefundEntity> {
        const refund = await this.prisma.refund.findUnique({
            where: { id },
            include: refundInclude,
        });

        if (!refund) throw new NotFoundException('Refund not found');

        return this.toEntity(refund);
    }

    /**
     * 对账统计：按状态 / 渠道 / 政策聚合，外加失败原因 Top N。
     *
     * 失败原因在库里是自由文本（渠道报错的原文），这里截断到 100 字符后计数，
     * 避免同一类错误因为后半段 traceId 不同被拆成几十条。
     */
    async stats(dto: QueryAdminRefundStatsDto): Promise<RefundStats> {
        const where: Prisma.RefundWhereInput = {};

        if (dto.organizationId) where.organizationId = dto.organizationId;
        if (dto.channel) where.channel = dto.channel;

        if (dto.from || dto.to) {
            where.createdAt = {
                ...(dto.from ? { gte: new Date(dto.from) } : {}),
                ...(dto.to ? { lte: new Date(dto.to) } : {}),
            };
        }

        const [total, byStatus, byChannel, byPolicy, failed] =
            await Promise.all([
                this.prisma.refund.aggregate({
                    where,
                    _count: { _all: true },
                    _sum: { amount: true, settledAmount: true },
                }),
                this.prisma.refund.groupBy({
                    by: ['status'],
                    where,
                    _count: { _all: true },
                    _sum: { amount: true },
                }),
                this.prisma.refund.groupBy({
                    by: ['channel'],
                    where,
                    _count: { _all: true },
                    _sum: { amount: true },
                }),
                this.prisma.refund.groupBy({
                    by: ['policyCode'],
                    where,
                    _count: { _all: true },
                    _sum: { amount: true },
                }),
                this.prisma.refund.findMany({
                    where: { ...where, status: RefundStatus.FAILED },
                    select: { failureReason: true },
                }),
            ]);

        const reasons = new Map<string, number>();

        for (const row of failed) {
            const reason = (row.failureReason ?? 'unknown').slice(0, 100);
            reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
        }

        return {
            total: {
                count: total._count._all,
                amount: total._sum.amount ?? 0,
                settledAmount: total._sum.settledAmount ?? 0,
            },
            byStatus: byStatus.map((row) => ({
                status: row.status,
                count: row._count._all,
                amount: row._sum.amount ?? 0,
            })),
            byChannel: byChannel.map((row) => ({
                channel: row.channel,
                count: row._count._all,
                amount: row._sum.amount ?? 0,
            })),
            byPolicy: byPolicy.map((row) => ({
                policyCode: row.policyCode ?? 'UNKNOWN',
                count: row._count._all,
                amount: row._sum.amount ?? 0,
            })),
            failures: [...reasons.entries()]
                .map(([reason, count]) => ({ reason, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 20),
        };
    }

    /** 政策试算：后台在发起之前先看「能退多少、订阅会怎样」。 */
    async quote(orderId: string) {
        const { quote, config } = await this.refunds.quote(orderId);

        return { ...quote, enabled: config.enabled };
    }

    async create(
        dto: CreateAdminRefundDto,
        adminUserId?: string,
    ): Promise<AdminRefundEntity> {
        const refund = await this.refunds.create({
            orderId: dto.orderId,
            type: dto.type,
            amount: dto.amount,
            reason: dto.reason,
            requestedBy: adminUserId,
        });

        return this.findOne(refund.id);
    }

    async retry(id: string): Promise<AdminRefundEntity> {
        const refund = await this.refunds.retry(id);

        return this.findOne(refund.id);
    }

    /** 审批通过：把停在 PENDING 的用户申请提交到渠道。 */
    async approve(
        id: string,
        adminUserId?: string,
    ): Promise<AdminRefundEntity> {
        const refund = await this.refunds.approve(id, adminUserId);

        return this.findOne(refund.id);
    }

    async close(id: string, reason?: string): Promise<AdminRefundEntity> {
        const refund = await this.refunds.markClosed(id, reason);

        return this.findOne(refund.id);
    }

    // -- Helpers ---------------------------------------------------------

    private toEntity(refund: AdminRefundRow): AdminRefundEntity {
        return new AdminRefundEntity({
            id: refund.id,
            refundNo: refund.refundNo,
            orderId: refund.orderId,
            orderNo: refund.order.orderNo,
            organizationId: refund.organizationId,
            channel: refund.channel,
            type: refund.type,
            status: refund.status,
            amount: refund.amount,
            settledAmount: refund.settledAmount,
            policyCode: refund.policyCode,
            usedDays: refund.usedDays,
            remainingDays: refund.remainingDays,
            reason: refund.reason,
            requestedBy: refund.requestedBy,
            approvedBy: refund.approvedBy,
            channelRefundId: refund.channelRefundId,
            failureReason: refund.failureReason,
            refundedAt: refund.refundedAt,
            createdAt: refund.createdAt,
            updatedAt: refund.updatedAt,
        });
    }
}
