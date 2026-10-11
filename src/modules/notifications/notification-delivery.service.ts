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
                        },
                    });
                if (!claimed.count) continue;
                try {
                    const payload = job.payload as Record<string, unknown>;
                    const audience = payload.audience as
                        | {
                              userId: string;
                              organizationId?: string;
                              allowOutsideOrg?: boolean;
                          }
                        | undefined;
                    const eligible =
                        !audience ||
                        (await this.prisma.user.findFirst({
                            where: {
                                id: audience.userId,
                                isActive: true,
                                deletedAt: null,
                                ...(job.channel === 'EMAIL'
                                    ? { emailVerified: true }
                                    : {}),
                                ...(audience.organizationId &&
                                !audience.allowOutsideOrg
                                    ? {
                                          memberships: {
                                              some: {
                                                  organizationId:
                                                      audience.organizationId,
                                              },
                                          },
                                      }
                                    : {}),
                            },
                            select: { id: true },
                        }));
                    let delivered = false;
                    if (job.channel === 'SSE') {
                        const notice =
                            await this.prisma.notification.findUnique({
                                where: { id: String(payload.notificationId) },
                            });
                        const activeLegacyRecipient =
                            !notice ||
                            audience ||
                            (await this.prisma.user.findFirst({
                                where: {
                                    id: notice.userId,
                                    isActive: true,
                                    deletedAt: null,
                                },
                                select: { id: true },
                            }));
                        if (notice && eligible && activeLegacyRecipient) {
                            const [projected] = await projectInvitationState(
                                this.prisma,
                                [new NotificationEntity(notice)],
                            );
                            await this.streams.emit(projected);
                            delivered = true;
                        }
                    } else if (job.channel === 'EMAIL') {
                        const data =
                            payload.data as EmailPayloadMap[EmailTemplate];
                        const validInvitation =
                            payload.template !== EmailTemplate.INVITATION ||
                            (await this.prisma.invitation.findFirst({
                                where: {
                                    token: (
                                        data as EmailPayloadMap[EmailTemplate.INVITATION]
                                    ).token,
                                    status: 'PENDING',
                                    expiresAt: { gt: new Date() },
                                    organization: { deletedAt: null },
                                },
                                select: { id: true },
                            }));
                        if (eligible && validInvitation) {
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
                        where: { id: job.id, leaseToken },
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
                        where: { id: job.id, leaseToken },
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
}
