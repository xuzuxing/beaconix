import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CheckerService } from './checker.service';

/**
 * Drives the local checks: every tick it asks CheckerService for the monitors
 * that are due and runs them. The tick is skipped while a previous one is still
 * running, so a slow target cannot pile up overlapping runs.
 */
@Injectable()
export class CheckerScheduler {
    private readonly logger = new Logger(CheckerScheduler.name);
    private running = false;

    constructor(private readonly checkerService: CheckerService) {}

    @Cron(CronExpression.EVERY_10_SECONDS, { name: 'monitor-checker' })
    async tick(): Promise<void> {
        if (this.running) {
            this.logger.debug(
                'Previous checker tick is still running - skipping',
            );
            return;
        }

        this.running = true;

        try {
            const { due, checked } = await this.checkerService.runDueChecks();

            if (due > 0) {
                this.logger.log(`Checked ${checked}/${due} due monitor(s)`);
            }
        } catch (error) {
            this.logger.error('Monitor checker tick failed', error as Error);
        } finally {
            this.running = false;
        }
    }
}
