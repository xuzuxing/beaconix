import { ApiProperty } from '@nestjs/swagger';
import {
    NotificationChannelType,
    NotificationStatus,
} from '../../../generated/prisma/enums';

class PageEntity {
    @ApiProperty() total: number;
    @ApiProperty() page: number;
    @ApiProperty() limit: number;
}

export class AlertEventEntity {
    @ApiProperty() id: string;
    @ApiProperty() projectId: string;
    @ApiProperty() monitorId: string;
    @ApiProperty({ description: 'Name at the time of the incident' })
    monitorName: string;
    @ApiProperty({
        description: 'Sanitized for administrators; redacted for other roles',
    })
    target: string;
    @ApiProperty() monitorDeleted: boolean;
    @ApiProperty({ enum: ['CONNECTIVITY', 'AVAILABILITY', 'SSL', 'NO_DATA'] })
    kind: string;
    @ApiProperty({ enum: ['warning', 'critical'] }) level: string;
    @ApiProperty({ enum: ['ongoing', 'resolved'] }) status: string;
    @ApiProperty() origin: string;
    @ApiProperty({ type: String, nullable: true }) suppressedReason:
        string | null;
    @ApiProperty({
        description: 'Condition reason code, not raw provider diagnostics',
    })
    reason: string;
    @ApiProperty({ type: Number, nullable: true }) threshold: number | null;
    @ApiProperty({ type: Number, nullable: true }) actual: number | null;
    @ApiProperty({ type: String, nullable: true }) unit: string | null;
    @ApiProperty({ format: 'date-time' }) startedAt: string;
    @ApiProperty({ type: String, format: 'date-time', nullable: true })
    resolvedAt: string | null;
    @ApiProperty({
        type: Number,
        nullable: true,
        description: 'Final duration; null while ongoing',
    })
    durationSeconds: number | null;
    @ApiProperty({ type: String, format: 'date-time', nullable: true })
    firstNotifiedAt: string | null;
    @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

export class AlertEventPageEntity extends PageEntity {
    @ApiProperty({ type: [AlertEventEntity] }) items: AlertEventEntity[];
}

class DeliveryStatusCountEntity {
    @ApiProperty() status: string;
    @ApiProperty() count: number;
}

export class AlertEventDetailEntity extends AlertEventEntity {
    @ApiProperty({ type: [DeliveryStatusCountEntity] })
    deliverySummary: DeliveryStatusCountEntity[];
    @ApiProperty({
        description:
            'Permission only; individual deliveries must also be FAILED',
    })
    canRetryDeliveries: boolean;
}

class AlertChannelSummaryEntity {
    @ApiProperty() id: string;
    @ApiProperty() name: string;
    @ApiProperty({ enum: NotificationChannelType })
    type: NotificationChannelType;
    @ApiProperty() enabled: boolean;
}

export class EventDeliveryEntity {
    @ApiProperty() id: string;
    @ApiProperty() eventId: string;
    @ApiProperty() eventRevision: number;
    @ApiProperty() channelId: string;
    @ApiProperty({
        type: AlertChannelSummaryEntity,
        nullable: true,
        description:
            'Current channel metadata; null if unavailable. No recipient configuration.',
    })
    channel: AlertChannelSummaryEntity | null;
    @ApiProperty({ enum: ['OPEN', 'RECOVERY'] }) phase: string;
    @ApiProperty({
        enum: ['PENDING', 'QUEUED', 'SENDING', 'SUCCESS', 'FAILED', 'SKIPPED'],
    })
    status: string;
    @ApiProperty({
        description:
            'Attempts in the current retry cycle, reset by manual retry',
    })
    attempts: number;
    @ApiProperty({ format: 'date-time' }) createdAt: string;
    @ApiProperty({ type: String, format: 'date-time', nullable: true })
    deliveredAt: string | null;
    @ApiProperty({
        format: 'date-time',
        description: 'Retry eligibility time, not a delivery promise',
    })
    nextAttemptAt: string;
    @ApiProperty() canRetry: boolean;
}

export class EventDeliveryPageEntity extends PageEntity {
    @ApiProperty({ type: [EventDeliveryEntity] }) items: EventDeliveryEntity[];
}

export class DeliveryAttemptEntity {
    @ApiProperty() id: string;
    @ApiProperty() deliveryId: string;
    @ApiProperty() eventId: string;
    @ApiProperty() channelId: string;
    @ApiProperty({ type: String, nullable: true }) phase: string | null;
    @ApiProperty({
        type: Number,
        nullable: true,
        description:
            'Attempt number within its retry cycle; may repeat after manual retry',
    })
    attempt: number | null;
    @ApiProperty({ enum: NotificationStatus }) status: NotificationStatus;
    @ApiProperty({ format: 'date-time' }) sentAt: string;
}

export class DeliveryAttemptPageEntity extends PageEntity {
    @ApiProperty({ type: [DeliveryAttemptEntity] })
    items: DeliveryAttemptEntity[];
}
