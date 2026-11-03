import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../infra/database/prisma.service';
import { RumRateLimitService } from './rum-rate-limit.service';

export interface ActiveRumApp {
    id: string;
    organizationId: string;
    projectId: string;
    name: string;
}

@Injectable()
export class RumPublicIngestService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly rateLimit: RumRateLimitService,
    ) {}

    async withActiveApp<T>(
        publicKey: string,
        source: string,
        work: (tx: Prisma.TransactionClient, app: ActiveRumApp) => Promise<T>,
    ): Promise<T> {
        const candidate = await this.prisma.rumApp.findUnique({
            where: { publicKey },
            select: {
                id: true,
                organizationId: true,
                projectId: true,
                name: true,
            },
        });
        if (!candidate) throw this.unavailable();

        await this.rateLimit.consume(candidate.id, source);

        return this.prisma.$transaction(async (tx) => {
            // Keep the same lock order as project authorization writes. App
            // disable and project archive wait for in-flight ingest, while a
            // request starting afterwards observes the updated state.
            await tx.$queryRaw`
                SELECT "id" FROM "organizations"
                WHERE "id" = ${candidate.organizationId} FOR SHARE
            `;
            await tx.$queryRaw`
                SELECT "id" FROM "projects"
                WHERE "id" = ${candidate.projectId} FOR SHARE
            `;
            await tx.$queryRaw`
                SELECT "id" FROM "rum_apps"
                WHERE "id" = ${candidate.id} FOR SHARE
            `;

            const app = await tx.rumApp.findFirst({
                where: {
                    id: candidate.id,
                    organizationId: candidate.organizationId,
                    projectId: candidate.projectId,
                    enabled: true,
                    deletedAt: null,
                    organization: { deletedAt: null },
                    project: { deletedAt: null, status: 'ACTIVE' },
                },
                select: {
                    id: true,
                    organizationId: true,
                    projectId: true,
                    name: true,
                },
            });
            if (!app) throw this.unavailable();
            return work(tx, app);
        });
    }

    private unavailable(): NotFoundException {
        return new NotFoundException('RUM app unavailable');
    }
}
