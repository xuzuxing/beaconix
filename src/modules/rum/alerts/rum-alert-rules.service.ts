import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { ProjectAccessService } from '../../../common/authorization/project-access.service';
import type { Prisma } from '../../../generated/prisma/client';
import { RumAlertMetric } from '../../../generated/prisma/enums';
import { PrismaService } from '../../../infra/database/prisma.service';
import type {
    CreateRumAlertRuleDto,
    QueryRumAlertIncidentsDto,
    UpdateRumAlertRuleDto,
} from '../dto';

@Injectable()
export class RumAlertRulesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
    ) {}

    async create(
        projectId: string,
        appId: string,
        dto: CreateRumAlertRuleDto,
        principal: AccessPrincipal,
    ) {
        this.validateMetric(dto.metric, dto.eventName);
        return this.access.withProject(
            principal,
            projectId,
            'app.manage',
            async (tx, access) => {
                await this.ensureApp(
                    tx,
                    access.organizationId,
                    projectId,
                    appId,
                );
                await this.validateChannels(
                    tx,
                    access.organizationId,
                    dto.channelIds ?? [],
                );
                return tx.rumAlertRule.create({
                    data: {
                        appId,
                        name: dto.name.trim(),
                        metric: dto.metric,
                        eventName:
                            dto.metric === RumAlertMetric.EVENT_COUNT
                                ? dto.eventName?.trim() || '*'
                                : null,
                        threshold: dto.threshold,
                        windowMinutes: dto.windowMinutes,
                        channelIds: dto.channelIds ?? [],
                        enabled: dto.enabled ?? true,
                        createdById:
                            principal.type === 'USER' ? principal.userId : null,
                    },
                });
            },
        );
    }

    async findAll(
        projectId: string,
        appId: string,
        principal: AccessPrincipal,
    ) {
        await this.authorize(projectId, appId, principal, 'rum.read');
        return this.prisma.rumAlertRule.findMany({
            where: { appId, deletedAt: null },
            orderBy: { createdAt: 'desc' },
        });
    }

    async update(
        projectId: string,
        appId: string,
        ruleId: string,
        dto: UpdateRumAlertRuleDto,
        principal: AccessPrincipal,
    ) {
        return this.access.withProject(
            principal,
            projectId,
            'app.manage',
            async (tx, access) => {
                await this.ensureApp(
                    tx,
                    access.organizationId,
                    projectId,
                    appId,
                );
                const current = await tx.rumAlertRule.findFirst({
                    where: { id: ruleId, appId, deletedAt: null },
                });
                if (!current)
                    throw new NotFoundException('RUM alert rule not found');
                const metric = dto.metric ?? current.metric;
                const eventName =
                    dto.eventName !== undefined
                        ? dto.eventName
                        : (current.eventName ?? undefined);
                this.validateMetric(metric, eventName);
                if (dto.channelIds)
                    await this.validateChannels(
                        tx,
                        access.organizationId,
                        dto.channelIds,
                    );
                if (dto.enabled === false && current.active)
                    await this.resolveActiveIncident(tx, current.id);
                return tx.rumAlertRule.update({
                    where: { id: current.id },
                    data: {
                        ...(dto.name !== undefined
                            ? { name: dto.name.trim() }
                            : {}),
                        ...(dto.metric !== undefined
                            ? { metric: dto.metric }
                            : {}),
                        ...(dto.metric !== undefined ||
                        dto.eventName !== undefined
                            ? {
                                  eventName:
                                      metric === RumAlertMetric.EVENT_COUNT
                                          ? eventName?.trim() || '*'
                                          : null,
                              }
                            : {}),
                        ...(dto.threshold !== undefined
                            ? { threshold: dto.threshold }
                            : {}),
                        ...(dto.windowMinutes !== undefined
                            ? { windowMinutes: dto.windowMinutes }
                            : {}),
                        ...(dto.channelIds !== undefined
                            ? { channelIds: dto.channelIds }
                            : {}),
                        ...(dto.enabled !== undefined
                            ? { enabled: dto.enabled }
                            : {}),
                        ...(dto.enabled === false ? { active: false } : {}),
                    },
                });
            },
        );
    }

    async remove(
        projectId: string,
        appId: string,
        ruleId: string,
        principal: AccessPrincipal,
    ): Promise<void> {
        await this.access.withProject(
            principal,
            projectId,
            'app.manage',
            async (tx, access) => {
                await this.ensureApp(
                    tx,
                    access.organizationId,
                    projectId,
                    appId,
                );
                const rule = await tx.rumAlertRule.findFirst({
                    where: { id: ruleId, appId, deletedAt: null },
                });
                if (!rule)
                    throw new NotFoundException('RUM alert rule not found');
                if (rule.active) await this.resolveActiveIncident(tx, rule.id);
                await tx.rumAlertRule.update({
                    where: { id: rule.id },
                    data: {
                        enabled: false,
                        active: false,
                        deletedAt: new Date(),
                    },
                });
            },
        );
    }

    async incidents(
        projectId: string,
        appId: string,
        query: QueryRumAlertIncidentsDto,
        principal: AccessPrincipal,
    ) {
        await this.authorize(projectId, appId, principal, 'rum.read');
        const where: Prisma.RumAlertIncidentWhereInput = {
            appId,
            ...(query.status ? { status: query.status } : {}),
        };
        const [items, total] = await this.prisma.$transaction([
            this.prisma.rumAlertIncident.findMany({
                where,
                include: {
                    rule: {
                        select: {
                            id: true,
                            name: true,
                            metric: true,
                            eventName: true,
                            windowMinutes: true,
                        },
                    },
                },
                orderBy: { startedAt: 'desc' },
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
            this.prisma.rumAlertIncident.count({ where }),
        ]);
        return { items, total, page: query.page, limit: query.limit };
    }

    private validateMetric(metric: RumAlertMetric, eventName?: string | null) {
        if (
            metric === RumAlertMetric.EVENT_COUNT &&
            eventName !== undefined &&
            eventName !== null &&
            !eventName.trim()
        )
            throw new BadRequestException('eventName must not be blank');
    }

    private async validateChannels(
        tx: Prisma.TransactionClient,
        organizationId: string,
        channelIds: string[],
    ) {
        if (!channelIds.length) return;
        const count = await tx.notificationChannel.count({
            where: { id: { in: channelIds }, organizationId },
        });
        if (count !== channelIds.length)
            throw new BadRequestException(
                'One or more notification channels are unavailable',
            );
    }

    private async resolveActiveIncident(
        tx: Prisma.TransactionClient,
        ruleId: string,
    ) {
        await tx.rumAlertIncident.updateMany({
            where: { ruleId, status: 'OPEN' },
            data: { status: 'RESOLVED', resolvedAt: new Date() },
        });
    }

    private async authorize(
        projectId: string,
        appId: string,
        principal: AccessPrincipal,
        action: 'rum.read' | 'app.manage',
    ) {
        const access = await this.access.project(principal, projectId, action);
        return this.ensureApp(
            this.prisma,
            access.organizationId,
            projectId,
            appId,
        );
    }

    private async ensureApp(
        db: Pick<PrismaService, 'rumApp'>,
        organizationId: string,
        projectId: string,
        appId: string,
    ) {
        const app = await db.rumApp.findFirst({
            where: {
                id: appId,
                organizationId,
                projectId,
                deletedAt: null,
            },
            select: { id: true },
        });
        if (!app) throw new NotFoundException('RUM app not found');
        return app;
    }
}
