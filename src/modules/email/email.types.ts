export enum EmailTemplate {
    INVITATION = 'invitation',
    WELCOME = 'welcome',
    PASSWORD_RESET = 'password-reset',
    TASK_ASSIGNED = 'task-assigned',
    TASK_DUE_SOON = 'task-due-soon',
    TASK_OVERDUE = 'task-overdue',
    EMAIL_VERIFICATION = 'email-verification',
    PASSWORD_RESET_OTP = 'password-reset-otp',
    MONITOR_DOWN = 'monitor-down',
    MONITOR_RECOVER = 'monitor-recover',
    TWO_FACTOR_ENABLED = 'two-factor-enabled',
    TWO_FACTOR_DISABLED = 'two-factor-disabled',
    TWO_FACTOR_RECOVERY_CODE_USED = 'two-factor-recovery-code-used',
}

export interface EmailPayloadMap {
    [EmailTemplate.INVITATION]: {
        to: string;
        orgName: string;
        token: string;
        inviterName: string;
    };
    [EmailTemplate.WELCOME]: {
        to: string;
        name: string;
        orgName: string;
    };
    [EmailTemplate.PASSWORD_RESET]: {
        to: string;
        name: string;
        resetUrl: string;
    };
    [EmailTemplate.TASK_ASSIGNED]: {
        to: string;
        name: string;
        taskTitle: string;
        taskUrl: string;
    };
    [EmailTemplate.TASK_DUE_SOON]: {
        to: string;
        name: string;
        taskTitle: string;
        taskNumber: number;
        dueDate: string;
        projectKey: string;
    };
    [EmailTemplate.TASK_OVERDUE]: {
        to: string;
        name: string;
        taskTitle: string;
        taskNumber: number;
        dueDate: string;
        projectKey: string;
    };
    [EmailTemplate.EMAIL_VERIFICATION]: {
        to: string;
        name: string;
        code: string;
        expiresInMinutes: number;
    };
    [EmailTemplate.PASSWORD_RESET_OTP]: {
        to: string;
        name: string;
        code: string;
        expiresInMinutes: number;
    };
    [EmailTemplate.MONITOR_DOWN]: MonitorEmailPayload;
    [EmailTemplate.MONITOR_RECOVER]: MonitorEmailPayload;
    [EmailTemplate.TWO_FACTOR_ENABLED]: TwoFactorSecurityEmailPayload;
    [EmailTemplate.TWO_FACTOR_DISABLED]: TwoFactorSecurityEmailPayload;
    [EmailTemplate.TWO_FACTOR_RECOVERY_CODE_USED]: RecoveryCodeUsedEmailPayload;
}

/** Payload for the 2FA enabled / disabled security notifications. */
export interface TwoFactorSecurityEmailPayload {
    to: string;
    name: string;
    /** ISO timestamp of when the change happened. */
    changedAt: string;
}

/** Payload for the "a recovery code was just used" security alert. */
export interface RecoveryCodeUsedEmailPayload {
    to: string;
    name: string;
    /** ISO timestamp of when the recovery code was consumed. */
    usedAt: string;
    /** Caller IP, or a placeholder when unknown. */
    ipAddress: string;
}

/** Shared payload for the monitoring alert / recovery emails. */
export interface MonitorEmailPayload {
    to: string;
    monitorName: string;
    target: string;
    status: string;
    previousStatus: string;
    error: string;
    latency: string;
    checkedAt: string;
}
