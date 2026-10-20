import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../infra/database/prisma.service';
import { PlanEntity } from './entities';

/** Only purchasable cycles are exposed to buyers; disabled ones stay internal. */
const ENABLED_TERMS: Prisma.PlanTermFindManyArgs = {
    where: { enabled: true },
    orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }],
};

@Injectable()
export class PlanService {
    constructor(private readonly prisma: PrismaService) {}

    async findAll(): Promise<PlanEntity[]> {
        const plans = await this.prisma.plan.findMany({
            where: { enabled: true },
            orderBy: { sortOrder: 'asc' },
            include: { terms: ENABLED_TERMS },
        });

        return plans.map((plan) => new PlanEntity(plan));
    }

    async findOne(id: string): Promise<PlanEntity> {
        const plan = await this.prisma.plan.findUnique({
            where: { id },
            include: { terms: ENABLED_TERMS },
        });

        if (!plan || !plan.enabled) {
            throw new NotFoundException('Plan not found');
        }

        return new PlanEntity(plan);
    }
}
