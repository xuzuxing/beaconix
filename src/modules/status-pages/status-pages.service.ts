import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { capacityRestricted } from '../../shared/subscription/monitor-capacity.util';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/database/prisma.service';
import { MultiLevelCacheService } from '../../infra/cache/multi-level-cache.service';
import { QuotaService } from '../../shared/quota/quota.service';
import { SettingsService } from '../settings';
import { MonitorStatus } from '../../generated/prisma/enums';
import type {
    MonitorModel,
    MonitorStateModel,
    StatusPageModel,
} from '../../generated/prisma/models';
import {
    CreateStatusPageDto,
    STATUS_PAGE_VISIBLE_MONITOR_LIMIT,
    UpdateStatusPageDto,
} from './dto';
import {
    PublicMonitorAvailabilityEntity,
    PublicStatusPageEntity,
    PublicStatusPageMonitorEntity,
    StatusPageEntity,
} from './entities';
import { sanitizeMonitoringTarget } from '../../common/authorization/monitoring-projection';
import { iso, roundPercent } from '../monitoring/monitoring-window.util';
import {
    availabilityBucketKey,
    availabilityDays,
    availabilityHistory,
    availabilityWindowStart,
    AVAILABILITY_HOURS,
    buildAvailabilityGrid,
    monitorHourlyRowsSql,
    reliableHistoryStart,
} from '../monitoring/availability.util';
import type {
    HourlyAvailabilityRow,
    MonitorHourlyAvailabilityRow,
} from '../monitoring/availability.util';

export const STATUS_PAGE_UPTIME_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Heatmap window of the public page: today plus the two preceding local days. */
export const STATUS_PAGE_AVAILABILITY_DAYS = 3;

/** Anonymous payloads are snapshot-cached briefly, keyed by slug and zone. */
export const STATUS_PAGE_CACHE_TTL_SECONDS = 60;

type MonitorWithState = MonitorModel & { state?: MonitorStateModel | null };
type Tx = Prisma.TransactionClient;

interface UptimeRow {
    monitorId: string;
    checks: number;
    successes: number;
}

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
        private readonly cache: MultiLevelCacheService,
        private readonly settings: SettingsService,
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

    /**
     * Public page. Disabled or missing pages both read as "not found".
     *
     * The payload is a snapshot: `asOf` is read from the database clock inside a
     * single read-only transaction, so the availability grid, the 24h uptime
     * ratio and the monitor states all describe the same instant.
     */
    async getPublicBySlug(
        slug: string,
        tz = 'Asia/Shanghai',
    ): Promise<PublicStatusPageEntity> {
        return this.cache.getOrSet(
            `status-page:v1:${slug}:${tz}`,
            () => this.buildPublicPage(slug, tz),
            STATUS_PAGE_CACHE_TTL_SECONDS,
            { l1Ttl: STATUS_PAGE_CACHE_TTL_SECONDS },
        );
    }

    private async buildPublicPage(
        slug: string,
        tz: string,
    ): Promise<PublicStatusPageEntity> {
        const page = await this.prisma.statusPage.findUnique({
            where: { slug, organization: { deletedAt: null } },
        });

        if (!page || !page.enabled) {
            throw new NotFoundException('Status page not found');
        }

        return this.prisma.$transaction(
            async (tx) => {
                await tx.$executeRaw`SET TRANSACTION READ ONLY`;
                const [clock] = await tx.$queryRaw<{ at: Date }[]>`
                    SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at`;
                const asOf = clock.at;

                const monitors = await tx.monitor.findMany({
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

                const monitorsView = await this.buildPublicMonitors(
                    tx,
                    page,
                    monitors,
                    tz,
                    asOf,
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
            },
            { isolationLevel: 'RepeatableRead', timeout: 30_000 },
        );
    }

    // -- Helpers ---------------------------------------------------------

    private async buildPublicMonitors(
        tx: Tx,
        page: StatusPageModel,
        monitors: MonitorWithState[],
        tz: string,
        asOf: Date,
    ): Promise<PublicStatusPageMonitorEntity[]> {
        const monitorIds = monitors.map((monitor) => monitor.id);
        const uptime = page.showUptime
            ? await this.uptimeByMonitor(tx, monitorIds, asOf)
            : new Map<string, UptimeRow>();
        const availability = page.showUptime
            ? await this.availabilityByMonitor(tx, monitors, tz, asOf)
            : new Map<string, PublicMonitorAvailabilityEntity>();

        return monitors.map((monitor) => {
            const state = monitor.state;
            const entity: Partial<PublicStatusPageMonitorEntity> = {
                id: monitor.id,
                name: monitor.name,
                type: monitor.type,
                target: sanitizeMonitoringTarget(monitor.target),
                status: capacityRestricted(monitor, asOf)
                    ? MonitorStatus.UNKNOWN
                    : (state?.status ?? MonitorStatus.UNKNOWN),
                lastCheckAt: state?.lastCheckAt ?? null,
            };

            if (page.showLatency) {
                entity.latency = state?.lastLatency ?? null;
            }

            if (page.showUptime) {
                const row = uptime.get(monitor.id);
                entity.uptimePercent =
                    row && row.checks > 0
                        ? roundPercent((100 * row.successes) / row.checks)
                        : null;
                entity.availability = availability.get(monitor.id);
            }

            return new PublicStatusPageMonitorEntity(entity);
        });
    }

    /**
     * 24h uptime per monitor in a single aggregate. The sample rule is the one
     * the page always had: every evaluated check of the window, LOCAL and probe
     * rows alike.
     */
    private async uptimeByMonitor(
        tx: Tx,
        monitorIds: string[],
        asOf: Date,
    ): Promise<Map<string, UptimeRow>> {
        if (!monitorIds.length) return new Map();

        const since = new Date(asOf.getTime() - STATUS_PAGE_UPTIME_WINDOW_MS);
        const rows = await tx.$queryRaw<UptimeRow[]>`
            SELECT "monitorId" AS "monitorId", COUNT(*)::integer AS checks,
            COUNT(*) FILTER (WHERE success)::integer AS successes
            FROM check_logs WHERE "monitorId" IN (${Prisma.join(monitorIds)})
            AND "checkedAt" >= ${since} AND evaluated = true
            GROUP BY "monitorId"`;

        return new Map(rows.map((row) => [row.monitorId, row]));
    }

    /**
     * Hourly availability of the last 3 local days, one grid per monitor.
     *
     * The visible monitors may span projects, so every grid is truncated
     * against the watermark of the project its monitor belongs to, while a
     * single aggregate still covers the whole set. A monitor whose project has
     * no coverage row (the project trigger normally guarantees one) is treated
     * as having no reliable history rather than being credited with cells
     * nobody can vouch for.
     */
    private async availabilityByMonitor(
        tx: Tx,
        monitors: MonitorWithState[],
        tz: string,
        asOf: Date,
    ): Promise<Map<string, PublicMonitorAvailabilityEntity>> {
        const grids = new Map<string, PublicMonitorAvailabilityEntity>();
        if (!monitors.length) return grids;

        const days = availabilityDays(tz, asOf, STATUS_PAGE_AVAILABILITY_DAYS);
        const from = availabilityWindowStart(days, tz);
        const watermarks = await this.projectWatermarks(tx, monitors, asOf);
        const rows = await tx.$queryRaw<MonitorHourlyAvailabilityRow[]>(
            monitorHourlyRowsSql({
                monitorIds: monitors.map((monitor) => monitor.id),
                tz,
                from,
                asOf,
            }),
        );
        const bucketsByMonitor = new Map<
            string,
            Map<string, HourlyAvailabilityRow>
        >();
        for (const row of rows) {
            const index =
                bucketsByMonitor.get(row.monitorId) ??
                new Map<string, HourlyAvailabilityRow>();
            index.set(availabilityBucketKey(row.day, row.hour), row);
            bucketsByMonitor.set(row.monitorId, index);
        }

        for (const monitor of monitors) {
            const availableFrom = watermarks.get(monitor.projectId) ?? asOf;
            const buckets = bucketsByMonitor.get(monitor.id);
            const grid = buildAvailabilityGrid({
                days,
                tz,
                asOf,
                availableFrom,
                lookup: (day, hour) =>
                    buckets?.get(availabilityBucketKey(day, hour)),
            });

            grids.set(
                monitor.id,
                new PublicMonitorAvailabilityEntity({
                    tz,
                    asOf: iso(asOf, tz),
                    from: days[0],
                    to: days[days.length - 1],
                    history: availabilityHistory({ tz, from, availableFrom }),
                    hours: AVAILABILITY_HOURS,
                    days,
                    cells: grid.cells,
                    unavailableCells: grid.unavailableCells,
                    worst: grid.worst
                        ? {
                              day: days[grid.worst[1]],
                              hour: grid.worst[0],
                              value: grid.worst[2],
                          }
                        : null,
                }),
            );
        }

        return grids;
    }

    /** Reliable history start per project, mirroring the monitoring coverage rule. */
    private async projectWatermarks(
        tx: Tx,
        monitors: MonitorWithState[],
        asOf: Date,
    ): Promise<Map<string, Date>> {
        const projectIds = [
            ...new Set(monitors.map((monitor) => monitor.projectId)),
        ];
        if (!projectIds.length) return new Map();

        const coverage = await tx.monitoringCoverage.findMany({
            where: { projectId: { in: projectIds } },
            select: { projectId: true, checksStartedAt: true },
        });

        return new Map(
            coverage.map((row) => [
                row.projectId,
                reliableHistoryStart(row.checksStartedAt, asOf),
            ]),
        );
    }

    private async validateVisibleMonitors(
        orgId: string,
        monitorIds: string[],
    ): Promise<string[]> {
        const ids = [...new Set(monitorIds)];

        if (ids.length > STATUS_PAGE_VISIBLE_MONITOR_LIMIT) {
            throw new BadRequestException(
                `A status page may expose at most ${STATUS_PAGE_VISIBLE_MONITOR_LIMIT} monitors`,
            );
        }

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
        // 状态页 slug 直接出现在公开 URL `/api/status/:slug` 上，平台自留名
        // （`admin`、`api`…）优先于占用判断：报 400 而非 409。
        await this.settings.assertSlugAllowed(slug, 'Status page slug');

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
