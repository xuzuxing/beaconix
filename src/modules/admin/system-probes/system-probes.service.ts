import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ProbeScope, ProbeStatus } from '../../../generated/prisma/enums';
import { ProbeEntity } from '../../probes/entities';
import { CreateSystemProbeDto, UpdateSystemProbeDto } from './dto';
import { SystemProbeScheduler } from './system-probe-scheduler';

@Injectable()
export class SystemProbesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly systemProbeScheduler: SystemProbeScheduler,
    ) {}

    async create(dto: CreateSystemProbeDto): Promise<ProbeEntity> {
        const probe = await this.prisma.probe.create({
            data: {
                scope: ProbeScope.SYSTEM,
                organizationId: null,
                name: dto.name,
                provider: dto.provider,
                region: dto.region,
                callbackUrl: dto.callbackUrl,
                enabled: dto.enabled ?? true,
                maxTenants: dto.maxTenants ?? 0,
                priority: dto.priority ?? 0,
                secret: this.generateSecret(),
            },
        });

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(probe);
    }

    async findAll(): Promise<ProbeEntity[]> {
        const probes = await this.prisma.probe.findMany({
            where: { scope: ProbeScope.SYSTEM },
            orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        });

        return probes.map((probe) => this.toEntity(probe));
    }

    async findOne(id: string): Promise<ProbeEntity> {
        return this.toEntity(await this.ensureSystemProbe(id));
    }

    async update(id: string, dto: UpdateSystemProbeDto): Promise<ProbeEntity> {
        await this.ensureSystemProbe(id);

        const probe = await this.prisma.probe.update({
            where: { id },
            data: {
                name: dto.name,
                provider: dto.provider,
                region: dto.region,
                callbackUrl: dto.callbackUrl,
                enabled: dto.enabled,
                maxTenants: dto.maxTenants,
                priority: dto.priority,
            },
        });

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(probe);
    }

    async toggle(id: string, enabled: boolean): Promise<ProbeEntity> {
        await this.ensureSystemProbe(id);

        const probe = await this.prisma.probe.update({
            where: { id },
            data: {
                enabled,
                status: enabled ? undefined : ProbeStatus.OFFLINE,
            },
        });

        await this.systemProbeScheduler.rebalance();

        return this.toEntity(probe);
    }

    async remove(id: string): Promise<void> {
        await this.ensureSystemProbe(id);
        await this.prisma.probe.delete({ where: { id } });
        await this.systemProbeScheduler.rebalance();
    }

    async rebalance() {
        return this.systemProbeScheduler.rebalance();
    }

    private async ensureSystemProbe(id: string) {
        const probe = await this.prisma.probe.findFirst({
            where: { id, scope: ProbeScope.SYSTEM },
        });

        if (!probe) {
            throw new NotFoundException('System probe not found');
        }

        return probe;
    }

    private generateSecret(): string {
        return `sys_${randomBytes(32).toString('hex')}`;
    }

    private toEntity(probe: {
        id: string;
        organizationId: string | null;
        scope: string;
        name: string;
        provider: string;
        region: string;
        callbackUrl: string;
        secret: string;
        enabled: boolean;
        lastHeartbeat: Date | null;
        status: string;
        maxTenants: number | null;
        priority: number;
        createdAt: Date;
        updatedAt: Date;
    }): ProbeEntity {
        return new ProbeEntity({
            id: probe.id,
            organizationId: probe.organizationId,
            scope: probe.scope,
            name: probe.name,
            provider: probe.provider,
            region: probe.region,
            callbackUrl: probe.callbackUrl,
            secret: probe.secret,
            enabled: probe.enabled,
            lastHeartbeat: probe.lastHeartbeat,
            status: probe.status,
            maxTenants: probe.maxTenants,
            priority: probe.priority,
            createdAt: probe.createdAt,
            updatedAt: probe.updatedAt,
            monitors: [],
        });
    }
}
