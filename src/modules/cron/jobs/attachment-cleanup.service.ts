import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';
import { StorageService } from '../../attachments/storage';

/** Uploads older than this with no host are abandoned. */
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

/** Rows handled per run, so a large backlog never holds one long pass. */
const BATCH_SIZE = 200;

/**
 * Removes uploads that were never attached to anything.
 *
 * A general upload lands in the table before a business flow claims it, so an
 * abandoned ticket form leaves both a row and a stored object behind. Anything
 * older than 24 hours whose `taskId` / `ticketId` / `ticketReplyId` are all
 * empty is garbage and is deleted together with its object.
 *
 * Runs daily at 3:30 AM, after the 3:00 AM monitoring history cleanup.
 */
@Injectable()
export class AttachmentCleanupService implements OnModuleInit {
    private readonly logger = new Logger(AttachmentCleanupService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly storage: StorageService,
        private readonly registry: ScheduledJobRegistry,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.attachmentCleanup,
            pattern: SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.attachmentCleanup],
            handler: () => this.handleAttachmentCleanup(),
        });
    }

    async handleAttachmentCleanup(): Promise<void> {
        const cutoff = new Date(Date.now() - ORPHAN_TTL_MS);
        const orphans = await this.prisma.attachment.findMany({
            where: {
                createdAt: { lt: cutoff },
                taskId: null,
                ticketId: null,
                ticketReplyId: null,
            },
            select: {
                id: true,
                fileKey: true,
                storageProvider: true,
                bucket: true,
            },
            orderBy: { createdAt: 'asc' },
            take: BATCH_SIZE,
        });

        if (!orphans.length) {
            this.logger.log('No orphan attachments to clean up');
            return;
        }

        let removed = 0;
        for (const orphan of orphans) {
            if (orphan.fileKey) {
                await this.storage
                    .deleteObject(
                        orphan.storageProvider,
                        orphan.fileKey,
                        orphan.bucket,
                    )
                    .catch(() =>
                        this.logger.warn(
                            `Failed to delete orphan object for attachment ${orphan.id}`,
                        ),
                    );
            }

            const deleted = await this.prisma.attachment
                .delete({ where: { id: orphan.id } })
                .then(() => true)
                .catch(() => false);
            if (deleted) removed += 1;
            else {
                this.logger.warn(
                    `Failed to delete orphan attachment row ${orphan.id}`,
                );
            }
        }

        this.logger.log(`Purged ${removed} orphan attachment(s)`);
    }
}
