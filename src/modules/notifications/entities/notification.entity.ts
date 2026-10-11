import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationType } from '../../../generated/prisma/enums';

export class NotificationEntity {
    @ApiProperty({ example: 'uuid-notification' })
    id: string;

    @ApiProperty({ example: 'uuid-user' })
    userId: string;

    @ApiProperty({
        enum: NotificationType,
        example: 'TASK_ASSIGNED',
    })
    type: string;

    @ApiProperty({ example: 'You were assigned to task #42' })
    title: string;

    @ApiPropertyOptional({
        example: 'Task "Fix login bug" was assigned to you',
    })
    body: string | null;

    @ApiProperty({ example: false })
    isRead: boolean;

    @ApiPropertyOptional({ example: '2025-03-01T10:00:00.000Z' })
    readAt: Date | null;

    @ApiPropertyOptional({ example: 'Task' })
    resourceType: string | null;

    @ApiPropertyOptional({ example: 'uuid-task' })
    resourceId: string | null;

    @ApiPropertyOptional({ type: Object, description: 'Additional metadata' })
    meta: any;

    @ApiProperty({ example: '2025-03-01T10:00:00.000Z' })
    createdAt: Date;

    constructor(partial: Partial<NotificationEntity>) {
        const {
            id,
            userId,
            type,
            title,
            body,
            isRead,
            readAt,
            resourceType,
            resourceId,
            meta,
            createdAt,
        } = partial;
        Object.assign(this, {
            id,
            userId,
            type,
            title,
            body,
            isRead,
            readAt,
            resourceType,
            resourceId,
            meta,
            createdAt,
        });
    }
}
