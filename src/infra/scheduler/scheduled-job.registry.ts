import { Injectable, Logger } from '@nestjs/common';
import type { ScheduledJobName } from './scheduled-jobs.constants';

export interface ScheduledJobDefinition {
    name: ScheduledJobName;
    /**
     * Standard five-field cron pattern (`minute hour day month weekday`).
     * BullMQ uses cron-parser, so the six-field (seconds) expressions from
     * `@nestjs/schedule` must not be copied over verbatim.
     */
    pattern: string;
    /** IANA timezone; the configured default applies when omitted. */
    timezone?: string;
    handler: () => Promise<unknown>;
}

/**
 * Collects the recurring jobs each feature module owns. Modules register their
 * handler in `onModuleInit`; the registrar publishes the schedules to BullMQ
 * once the application is fully bootstrapped, so a job never fires before its
 * handler exists.
 */
@Injectable()
export class ScheduledJobRegistry {
    private readonly logger = new Logger(ScheduledJobRegistry.name);
    private readonly jobs = new Map<ScheduledJobName, ScheduledJobDefinition>();

    register(job: ScheduledJobDefinition): void {
        if (this.jobs.has(job.name)) {
            throw new Error(
                `Scheduled job "${job.name}" is already registered`,
            );
        }

        this.jobs.set(job.name, job);
    }

    get(name: string): ScheduledJobDefinition | undefined {
        return this.jobs.get(name as ScheduledJobName);
    }

    list(): ScheduledJobDefinition[] {
        return [...this.jobs.values()];
    }
}
