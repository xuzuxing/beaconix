import {
    Injectable,
    Logger,
    OnModuleInit,
    OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../infra/scheduler/scheduled-jobs.constants';
import { EmailService } from '../email/email.service';
import { EmailTemplate, EmailPayloadMap } from '../email/email.types';
import { NotificationEntity } from './entities';
import { NotificationStreamService } from './notification-stream.service';
import { projectInvitationState } from './invitation-notification-state';
import { NotificationAccessService } from './notification-access.service';
import type { NotificationAudience } from './notification-event';
import {
    lockIdentities,
    lockMemberships,
    lockOrganization,
    lockProjects,
} from '../../common/authorization/access-locks';
import type { NotificationDelivery } from '../../generated/prisma/client';

@Injectable()
export class NotificationDeliveryService
    implements OnModuleInit, OnModuleDestroy
{
    private readonly logger = new Logger(NotificationDeliveryService.name);
    private timer?: NodeJS.Timeout;
    private processing = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly email: EmailService,
        private readonly streams: NotificationStreamService,
        private readonly registry: ScheduledJobRegistry,
        private readonly authorization: NotificationAccessService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.workspaceNotificationDelivery,
            pattern:
                SCHEDULED_JOB_PATTERNS[
                    SCHEDULED_JOBS.workspaceNotificationDelivery
                ],
            handler: () => this.processPending(),
        });
        // The DB leases make this fast poll safe across replicas; the scheduled
        // job also drains the outbox after worker restarts or delayed requests.
        this.timer = setInterval(() => this.kick(), 1000);
        this.timer.unref();
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer);
    }

    kick(): void {
        void this.processPending().catch(() => {
            this.logger.error('Workspace notification outbox drain failed');
        });
    }

    async processPending(): Promise<void> {
        if (this.processing) return;
        this.processing = true;
        try {
            const now = new Date();
            const jobs = await this.prisma.notificationDelivery.findMany({
                where: {
                    OR: [
                        { status: 'PENDING', availableAt: { lte: now } },
                        { status: 'SENDING', leaseUntil: { lt: now } },
                    ],
                },
                orderBy: { createdAt: 'asc' },
                take: 50,
            });
            for (const job of jobs) {
                const leaseToken = randomUUID();
                const claimed =
                    await this.prisma.notificationDelivery.updateMany({
                        where: {
                            id: job.id,
                            OR: [
                                {
                                    status: 'PENDING',
                                    availableAt: { lte: new Date() },
                                },
                                {
                                    status: 'SENDING',
                                    leaseUntil: { lt: new Date() },
                                },
                            ],
                        },
                        data: {
                            status: 'SENDING',
                            leaseToken,
                            leaseUntil: new Date(Date.now() + 120_000),
                            attempts: { increment: 1 },
                            dispatchAuthorizedAt: null,
                        },
                    });
                if (!claimed.count) continue;
                try {
                    const authorized = await this.authorizeDispatch(
                        job,
                        leaseToken,
                    );
                    if (!authorized) continue;
                    const payload = authorized.payload as Record<
                        string,
                        unknown
                    >;
                    const renew = async () =>
                        (
                            await this.prisma.notificationDelivery.updateMany({
                                where: {
                                    id: job.id,
                                    leaseToken,
                                    status: 'SENDING',
                                    dispatchAuthorizedAt: { not: null },
                                    leaseUntil: { gt: new Date() },
                                },
                                data: {
                                    leaseUntil: new Date(Date.now() + 120_000),
                                },
                            })
                        ).count > 0;
                    let delivered = false;
                    if (job.channel === 'SSE') {
                        const notice =
                            await this.prisma.notification.findUnique({
                                where: { id: String(payload.notificationId) },
                            });
                        const audience =
                            payload.audience as NotificationAudience;
                        if (
                            notice &&
                            notice.accessScope === audience.accessScope &&
                            notice.userId === audience.userId &&
                            notice.organizationId ===
                                (audience.organizationId ?? null) &&
                            notice.projectId === (audience.projectId ?? null)
                        ) {
                            const [projected] = await projectInvitationState(
                                this.prisma,
                                [new NotificationEntity(notice)],
                            );
                            if (!(await renew())) continue;
                            await this.streams.emit(projected);
                            delivered = true;
                        }
                    } else if (job.channel === 'EMAIL') {
                        const data =
                            payload.data as EmailPayloadMap[EmailTemplate];
                        const audience =
                            payload.audience as NotificationAudience;
                        if (
                            audience.accessScope !== 'INVITATION' ||
                            payload.template === EmailTemplate.INVITATION
                        ) {
                            if (!(await renew())) continue;
                            await this.email.send(
                                payload.template as EmailTemplate,
                                data,
                                job.dedupKey,
                            );
                            delivered = true;
                        }
                    } else {
                        throw new Error(
                            'Unsupported notification delivery channel',
                        );
                    }
                    await this.prisma.notificationDelivery.updateMany({
                        where: {
                            id: job.id,
                            leaseToken,
                            status: 'SENDING',
                            leaseUntil: { gt: new Date() },
                        },
                        data: {
                            status: delivered ? 'SENT' : 'SKIPPED',
                            deliveredAt: delivered ? new Date() : null,
                            leaseToken: null,
                            leaseUntil: null,
                            lastError: null,
                        },
                    });
                } catch {
                    await this.prisma.notificationDelivery.updateMany({
                        where: {
                            id: job.id,
                            leaseToken,
                            status: 'SENDING',
                            leaseUntil: { gt: new Date() },
                        },
                        data: {
                            status: 'PENDING',
                            availableAt: new Date(
                                Date.now() +
                                    Math.min(
                                        3600_000,
                                        1000 *
                                            2 ** Math.min(job.attempts + 1, 12),
                                    ),
                            ),
                            leaseToken: null,
                            leaseUntil: null,
                            dispatchAuthorizedAt: null,
                            lastError: 'Delivery failed; retry scheduled',
                        },
                    });
                    this.logger.warn(
                        `Workspace notification delivery ${job.id} failed; retry scheduled`,
                    );
                }
            }
        } finally {
            this.processing = false;
        }
    }

    private async authorizeDispatch(
        job: NotificationDelivery,
        leaseToken: string,
    ) {
        const audience = (job.payload as Record<string, unknown>)?.audience as
            NotificationAudience | undefined;
        return this.prisma.$transaction(async (tx) => {
            if (audience?.userId) {
                await lockIdentities(tx, [
                    { type: 'USER', userId: audience.userId },
                ]);
            }
            if (audience?.organizationId) {
                await lockOrganization(tx, audience.organizationId);
                if (audience.userId) {
                    const members = await tx.membership.findMany({
                        where: {
                            organizationId: audience.organizationId,
                            userId: audience.userId,
                        },
                        select: { id: true },
                    });
                    await lockMemberships(tx, members);
                }
                if (audience.projectId)
                    await lockProjects(tx, [audience.projectId]);
                if (audience.invitationId) {
                    await tx.$queryRaw`
                        SELECT "id" FROM "invitations" WHERE "id" = ${audience.invitationId} FOR SHARE
                    `;
                }
            }
            await tx.$queryRaw`
                SELECT "id" FROM "notification_deliveries" WHERE "id" = ${job.id} FOR UPDATE
            `;
            const current = await tx.notificationDelivery.findFirst({
                where: {
                    id: job.id,
                    leaseToken,
                    status: 'SENDING',
                    leaseUntil: { gt: new Date() },
                },
            });
            if (!current) return null;
            const currentAudience = (current.payload as Record<string, unknown>)
                ?.audience as NotificationAudience | undefined;
            const eligible =
                JSON.stringify(currentAudience) === JSON.stringify(audience) &&
                (await this.authorization.eligible(
                    currentAudience,
                    tx,
                    current.channel === 'EMAIL',
                ));
            const changed = await tx.notificationDelivery.updateMany({
                where: {
                    id: job.id,
                    leaseToken,
                    status: 'SENDING',
                    leaseUntil: { gt: new Date() },
                },
                data: eligible
                    ? { dispatchAuthorizedAt: new Date() }
                    : {
                          status: 'SKIPPED',
                          leaseToken: null,
                          leaseUntil: null,
                          dispatchAuthorizedAt: null,
                          deliveredAt: null,
                      },
            });
            return eligible && changed.count ? current : null;
        });
    }
}
