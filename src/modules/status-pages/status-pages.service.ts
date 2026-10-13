import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../infra/database/prisma.service';
import { QuotaService } from '../../shared/quota/quota.service';
import { MonitorStatus } from '../../generated/prisma/enums';
import type {
    MonitorModel,
    MonitorStateModel,
    StatusPageModel,
} from '../../generated/prisma/models';
import { CreateStatusPageDto, UpdateStatusPageDto } from './dto';
import {
    PublicStatusPageEntity,
    PublicStatusPageMonitorEntity,
    StatusPageEntity,
} from './entities';
import { sanitizeMonitoringTarget } from '../../common/authorization/monitoring-projection';

export const STATUS_PAGE_UPTIME_WINDOW_MS = 24 * 60 * 60 * 1000;

type MonitorWithState = MonitorModel & { state?: MonitorStateModel | null };

/** Aggregate rule: DOWN wins over DEGRADED, which wins over UP/UNKNOWN. */
export function deriveOverallStatus(statuses: string[]): string {
    if (statuses.length === 0) return 'UNKNOWN';
    if (statuses.includes(MonitorStatus.DOWN)) return MonitorStatus.DOWN;
    if (statuses.includes(MonitorStatus.DEGRADED)) {
        return MonitorStatus.DEGRADED;
    }
    if (statuses.every((status) => status === MonitorStatus.UP)) {
        return MonitorStatus.UP;
    }
    return MonitorStatus.UNKNOWN;
}

@Injectable()
export class StatusPagesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly quotaService: QuotaService,
    ) {}

    async create(
        orgId: string,
        dto: CreateStatusPageDto,
    ): Promise<StatusPageEntity> {
        await this.quotaService.assertFeatureAllowed(orgId, 'statusPage');

        const visibleMonitorIds = await this.validateVisibleMonitors(
            orgId,
            dto.visibleMonitorIds ?? [],
        );
        const slug = dto.slug
            ? await this.ensureSlugAvailable(dto.slug)
            : await this.generateUniqueSlug(dto.title);

        const page = await this.prisma.statusPage.create({
            data: {
                organizationId: orgId,
                slug,
                title: dto.title,
                description: dto.description,
                visibleMonitorIds,
                showLatency: dto.showLatency ?? true,
                showUptime: dto.showUptime ?? false,
                enabled: dto.enabled ?? true,
            },
        });

        return new StatusPageEntity(page);
    }

    async findAll(orgId: string): Promise<StatusPageEntity[]> {
        const pages = await this.prisma.statusPage.findMany({
            where: { organizationId: orgId },
            orderBy: { createdAt: 'desc' },
        });

        return pages.map((page) => new StatusPageEntity(page));
    }

    async findOne(orgId: string, id: string): Promise<StatusPageEntity> {
        return new StatusPageEntity(
            await this.ensureStatusPageExists(orgId, id),
        );
    }

    async update(
        orgId: string,
        id: string,
        dto: UpdateStatusPageDto,
    ): Promise<StatusPageEntity> {
        const existing = await this.ensureStatusPageExists(orgId, id);

        const visibleMonitorIds =
            dto.visibleMonitorIds !== undefined
                ? await this.validateVisibleMonitors(
                      orgId,
                      dto.visibleMonitorIds,
                  )
                : existing.visibleMonitorIds;

        const slug =
            dto.slug && dto.slug !== existing.slug
                ? await this.ensureSlugAvailable(dto.slug)
                : existing.slug;

        const page = await this.prisma.statusPage.update({
            where: { id },
            data: {
                slug,
                title: dto.title,
                description: dto.description,
                visibleMonitorIds,
                showLatency: dto.showLatency,
                showUptime: dto.showUptime,
                enabled: dto.enabled,
            },
        });

        return new StatusPageEntity(page);
    }

    async remove(orgId: string, id: string): Promise<void> {
        await this.ensureStatusPageExists(orgId, id);
        await this.prisma.statusPage.delete({ where: { id } });
    }

    /** Public page. Disabled or missing pages both read as "not found". */
    async getPublicBySlug(slug: string): Promise<PublicStatusPageEntity> {
        const page = await this.prisma.statusPage.findUnique({
            where: { slug, organization: { deletedAt: null } },
        });

        if (!page || !page.enabled) {
            throw new NotFoundException('Status page not found');
        }

        const monitors = await this.prisma.monitor.findMany({
            where: {
                id: { in: page.visibleMonitorIds },
                organizationId: page.organizationId,
                deletedAt: null,
                project: {
                    organizationId: page.organizationId,
                    deletedAt: null,
                    organization: { deletedAt: null },
                },
            },
            include: { state: true },
            orderBy: { createdAt: 'asc' },
        });

        const monitorsView = await Promise.all(
            monitors.map((monitor) => this.buildPublicMonitor(page, monitor)),
        );

        return new PublicStatusPageEntity({
            slug: page.slug,
            title: page.title,
            description: page.description,
            overallStatus: deriveOverallStatus(
                monitorsView.map((monitor) => monitor.status),
            ),
            showLatency: page.showLatency,
            showUptime: page.showUptime,
            monitors: monitorsView,
            updatedAt: page.updatedAt,
        });
    }

    // -- Helpers ---------------------------------------------------------

    private async buildPublicMonitor(
        page: StatusPageModel,
        monitor: MonitorWithState,
    ): Promise<PublicStatusPageMonitorEntity> {
        const state = monitor.state;

        const entity: Partial<PublicStatusPageMonitorEntity> = {
            id: monitor.id,
            name: monitor.name,
            type: monitor.type,
            target: sanitizeMonitoringTarget(monitor.target),
            status: state?.status ?? MonitorStatus.UNKNOWN,
            lastCheckAt: state?.lastCheckAt ?? null,
        };

        if (page.showLatency) {
            entity.latency = state?.lastLatency ?? null;
        }

        if (page.showUptime) {
            const since = new Date(Date.now() - STATUS_PAGE_UPTIME_WINDOW_MS);
            const window = {
                monitorId: monitor.id,
                checkedAt: { gte: since },
                evaluated: true,
            };

            const [totalChecks, successfulChecks] = await Promise.all([
                this.prisma.checkLog.count({ where: window }),
                this.prisma.checkLog.count({
                    where: { ...window, success: true },
                }),
            ]);

            entity.uptimePercent =
                totalChecks > 0
                    ? Math.round((successfulChecks / totalChecks) * 10000) / 100
                    : null;
        }

        return new PublicStatusPageMonitorEntity(entity);
    }

    private async validateVisibleMonitors(
        orgId: string,
        monitorIds: string[],
    ): Promise<string[]> {
        const ids = [...new Set(monitorIds)];

        if (ids.length === 0) return [];

        const found = await this.prisma.monitor.findMany({
            where: {
                id: { in: ids },
                organizationId: orgId,
                deletedAt: null,
                project: {
                    organizationId: orgId,
                    deletedAt: null,
                    organization: { deletedAt: null },
                },
            },
            select: { id: true },
        });

        if (found.length !== ids.length) {
            throw new BadRequestException(
                'One or more visible monitors do not belong to this organization',
            );
        }

        return ids;
    }

    private async ensureStatusPageExists(
        orgId: string,
        id: string,
    ): Promise<StatusPageModel> {
        const page = await this.prisma.statusPage.findFirst({
            where: { id, organizationId: orgId },
        });

        if (!page) {
            throw new NotFoundException('Status page not found');
        }

        return page;
    }

    private async ensureSlugAvailable(slug: string): Promise<string> {
        const existing = await this.prisma.statusPage.findUnique({
            where: { slug },
            select: { id: true },
        });

        if (existing) {
            throw new ConflictException('Status page slug is already in use');
        }

        return slug;
    }

    private async generateUniqueSlug(title: string): Promise<string> {
        const base = this.slugify(title);

        for (let attempt = 0; attempt < 5; attempt += 1) {
            const candidate = `${base}-${randomBytes(4).toString('hex')}`;
            const existing = await this.prisma.statusPage.findUnique({
                where: { slug: candidate },
                select: { id: true },
            });

            if (!existing) return candidate;
        }

        throw new ConflictException('Could not generate a unique slug');
    }

    private slugify(title: string): string {
        const slug = title
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60);

        return slug || 'status';
    }
}
