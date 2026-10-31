import { Injectable, OnModuleInit } from '@nestjs/common';
import { ScheduledJobRegistry } from '../../../infra/scheduler/scheduled-job.registry';
import {
    SCHEDULED_JOBS,
    SCHEDULED_JOB_PATTERNS,
} from '../../../infra/scheduler/scheduled-jobs.constants';
import { PaymentService } from '../../billing/payment/payment.service';

@Injectable()
export class PaymentReconcileService implements OnModuleInit {
    constructor(
        private readonly registry: ScheduledJobRegistry,
        private readonly payments: PaymentService,
    ) {}

    onModuleInit(): void {
        this.registry.register({
            name: SCHEDULED_JOBS.paymentReconcile,
            pattern: SCHEDULED_JOB_PATTERNS[SCHEDULED_JOBS.paymentReconcile],
            handler: () => this.payments.reconcilePendingAttempts(),
        });
    }
}
