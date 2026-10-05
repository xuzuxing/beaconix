import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import { PlanEntity } from './entities';

@Injectable()
export class PlanService {
    constructor(private readonly prisma: PrismaService) {}

    async findAll(): Promise<PlanEntity[]> {
        const plans = await this.prisma.plan.findMany({
            where: { enabled: true },
            orderBy: { sortOrder: 'asc' },
        });

        return plans.map((plan) => new PlanEntity(plan));
    }

    async findOne(id: string): Promise<PlanEntity> {
        const plan = await this.prisma.plan.findUnique({ where: { id } });

        if (!plan || !plan.enabled) {
            throw new NotFoundException('Plan not found');
        }

        return new PlanEntity(plan);
    }
}
