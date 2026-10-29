/**
 * Queue that carries every recurring job. A single scheduler in Redis produces
 * the jobs and any number of replicas may host a worker, but each job is
 * delivered to exactly one worker - that is what replaces the in-process
 * `@Cron` timers, which ran once per replica.
 */
export const SCHEDULED_JOBS_QUEUE = 'scheduled-jobs';

/**
 * Stable job ids. They double as the BullMQ job scheduler id and the queue job
 * name, and they match the names the old `@Cron(...)` decorators used.
 */
export const SCHEDULED_JOBS = {
    invitationExpiry: 'invitation-expiry',
    taskDueSoon: 'task-due-soon',
    taskOverdue: 'task-overdue',
    tokenCleanup: 'token-cleanup',
    monitorDataCleanup: 'monitor-data-cleanup',
    attachmentCleanup: 'attachment-cleanup',
    orderExpirySweep: 'order-expiry-sweep',
    subscriptionExpirySweep: 'subscription-expiry-sweep',
    monitorCapacitySweep: 'monitor-capacity-sweep',
    systemProbeAssignmentRefresh: 'system-probe-assignment-refresh',
    probeOfflineSweep: 'probe-offline-sweep',
    alertOutboxSweep: 'alert-outbox-sweep',
    probeIngestSweep: 'probe-ingest-sweep',
    workspaceNotificationDelivery: 'workspace-notification-delivery',
    wechatVirtualPayReconcile: 'wechat-virtual-pay-reconcile',
    refundReconcile: 'refund-reconcile',
} as const;

export type ScheduledJobName =
    (typeof SCHEDULED_JOBS)[keyof typeof SCHEDULED_JOBS];

/**
 * Cron pattern per job, in **five fields** (`minute hour day month weekday`) as
 * cron-parser - and therefore BullMQ - expects them.
 *
 * The old `@nestjs/schedule` expressions were a mix of five and six fields
 * (for example `EVERY_HOUR = '0 0-23/1 * * *'`), so they must not be copied over
 * verbatim; keep this table as the single source of truth for the schedule.
 */
export const SCHEDULED_JOB_PATTERNS: Record<ScheduledJobName, string> = {
    'invitation-expiry': '0 * * * *',
    'task-due-soon': '0 */6 * * *',
    'task-overdue': '0 8 * * *',
    'token-cleanup': '0 2 * * *',
    'monitor-data-cleanup': '0 3 * * *',
    'attachment-cleanup': '30 3 * * *',
    'order-expiry-sweep': '*/5 * * * *',
    'subscription-expiry-sweep': '0 * * * *',
    'monitor-capacity-sweep': '* * * * *',
    // Capacity deadlines and retained-list changes must release scarce slots promptly.
    'system-probe-assignment-refresh': '* * * * *',
    'probe-offline-sweep': '* * * * *',
    'alert-outbox-sweep': '* * * * *',
    'probe-ingest-sweep': '* * * * *',
    'workspace-notification-delivery': '* * * * *',
    // 虚拟支付官方建议：推送丢失时每 5 分钟查单兜底一次
    'wechat-virtual-pay-reconcile': '*/5 * * * *',
    // 退款同理：微信回调可能丢失，支付宝压根没有退款回调
    'refund-reconcile': '*/5 * * * *',
};
