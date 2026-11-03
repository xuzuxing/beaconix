import {
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { ProjectAccessService } from '../../../common/authorization/project-access.service';
import type { RumConfig } from '../../../config';
import { PrismaService } from '../../../infra/database/prisma.service';
import type { CreateRumAppDto, UpdateRumAppDto } from '../dto';

@Injectable()
export class RumAppsService {
    private readonly config: RumConfig;

    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ProjectAccessService,
        configService: ConfigService,
    ) {
        this.config = configService.get<RumConfig>('rum')!;
    }

    async create(
        projectId: string,
        dto: CreateRumAppDto,
        principal: AccessPrincipal,
    ) {
        return this.access.withProject(
            principal,
            projectId,
            'app.manage',
            async (tx, access) => {
                const count = await tx.rumApp.count({
                    where: { projectId, deletedAt: null },
                });
                if (count >= this.config.maxAppsPerProject) {
                    throw new ConflictException(
                        `RUM app limit reached (${this.config.maxAppsPerProject})`,
                    );
                }

                return tx.rumApp.create({
                    data: {
                        name: dto.name.trim(),
                        platform: dto.platform,
                        publicKey: this.createPublicKey(),
                        organizationId: access.organizationId,
                        projectId,
                        createdById:
                            principal.type === 'USER' ? principal.userId : null,
                    },
                });
            },
            'UPDATE',
        );
    }

    async findAll(projectId: string, principal: AccessPrincipal) {
        const access = await this.access.project(
            principal,
            projectId,
            'app.read',
        );
        return this.prisma.rumApp.findMany({
            where: {
                projectId,
                organizationId: access.organizationId,
                deletedAt: null,
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findOne(
        projectId: string,
        appId: string,
        principal: AccessPrincipal,
    ) {
        const access = await this.access.project(
            principal,
            projectId,
            'app.read',
        );
        return this.ensureApp(
            this.prisma,
            access.organizationId,
            projectId,
            appId,
        );
    }

    async update(
        projectId: string,
        appId: string,
        dto: UpdateRumAppDto,
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
                return tx.rumApp.update({
                    where: { id: appId },
                    data: {
                        ...(dto.name !== undefined
                            ? { name: dto.name.trim() }
                            : {}),
                        ...(dto.platform !== undefined
                            ? { platform: dto.platform }
                            : {}),
                    },
                });
            },
        );
    }

    async setEnabled(
        projectId: string,
        appId: string,
        enabled: boolean,
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
                return tx.rumApp.update({
                    where: { id: appId },
                    data: { enabled },
                });
            },
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
        });
        if (!app) throw new NotFoundException('RUM app not found');
        return app;
    }

    private createPublicKey(): string {
        return `rum_${randomBytes(18).toString('base64url')}`;
    }
}
