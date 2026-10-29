import { Injectable } from '@nestjs/common';
import { EffectivePlanService } from '../../../shared/subscription/effective-plan.service';
import { MonitorCapacityService } from '../../../shared/subscription/monitor-capacity.service';
import { ProjectAccessService } from '../../../common/authorization/project-access.service';
import type { JwtPayload } from '../../../common/interfaces/jwt-payload.interface';
import type { Prisma } from '../../../generated/prisma/client';
import { SelectMonitorCapacityDto } from './dto/select-monitor-capacity.dto';

@Injectable()
export class BillingMonitorCapacityService {
    constructor(
        private readonly plans: EffectivePlanService,
        private readonly capacity: MonitorCapacityService,
        private readonly access: ProjectAccessService,
    ) {}

    get(orgId: string, user: JwtPayload) {
        return this.access.withOrganization(
            { type: 'USER', userId: user.sub },
            orgId,
            async (tx) => {
                await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
                const plan = await this.plans.getEffectivePlanInTransaction(
                    orgId,
                    tx,
                );
                return this.view(tx, orgId, plan?.maxMonitors ?? 0);
            },
        );
    }

    select(orgId: string, user: JwtPayload, dto: SelectMonitorCapacityDto) {
        return this.access.withOrganization(
            { type: 'USER', userId: user.sub },
            orgId,
            async (tx) => {
                await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
                const plan = await this.plans.getEffectivePlanInTransaction(
                    orgId,
                    tx,
                );
                await this.capacity.select(
                    tx,
                    orgId,
                    dto.cycleId,
                    dto.monitorIds,
                );
                if (plan) await this.capacity.reconcile(tx, orgId, plan);
                return this.view(tx, orgId, plan?.maxMonitors ?? 0);
            },
        );
    }

    private async view(
        tx: Prisma.TransactionClient,
        orgId: string,
        limit: number,
    ) {
        const [capacity, total] = await Promise.all([
            this.capacity.view(orgId, tx),
            tx.monitor.count({
                where: { organizationId: orgId, deletedAt: null },
            }),
        ]);
        return {
            ...capacity,
            limit,
            total,
            overLimit: total > limit,
            excess: Math.max(0, total - limit),
        };
    }
}
