import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
    MONITOR_CHECK_QUEUE,
    MONITOR_SCAN_QUEUE,
} from '../../modules/checker/checker.queue';
import { NOTIFICATION_QUEUE } from '../../modules/notifier/notifier.queue';
import { QueueModule, registerQueue } from './queue.module';

/**
 * Every queue name the application uses. The constants stay next to the feature
 * that owns them; this module is the single place where they are registered.
 */
const QUEUE_NAMES = [
    MONITOR_SCAN_QUEUE,
    MONITOR_CHECK_QUEUE,
    NOTIFICATION_QUEUE,
];

/**
 * Registers all BullMQ queues and shares the resulting instances.
 *
 * Feature modules import this module instead of calling `registerQueue`
 * themselves: a queue registered in several modules gets one set of Redis
 * connections per module, so producers and consumers would no longer be
 * guaranteed to talk through the same instance.
 *
 * Note: the export has to name the module class. Nest only lets a module export
 * its own providers or the module classes it imports - listing the queue tokens
 * (`getQueueToken(name)`) here fails with UnknownExportException, since those
 * tokens belong to the imported BullModule instances, not to this module.
 */
@Module({
    imports: [
        // Shared connection. Importing it here as well keeps this module
        // self-contained; Nest instantiates the module once regardless.
        QueueModule,
        ...QUEUE_NAMES.map((name) => registerQueue(name)),
    ],
    exports: [BullModule],
})
export class QueuesModule {}
