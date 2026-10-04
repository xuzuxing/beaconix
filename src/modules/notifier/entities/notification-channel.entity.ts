import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationChannelType } from '../../../generated/prisma/enums';

export class NotificationChannelEntity {
    @ApiProperty({ example: 'uuid-channel' })
    id: string;

    @ApiProperty({ example: 'uuid-org' })
    organizationId: string;

    @ApiProperty({
        enum: NotificationChannelType,
        example: NotificationChannelType.FEISHU,
    })
    type: string;

    @ApiProperty({ example: 'Platform alerts' })
    name: string;

    @ApiProperty({
        type: Object,
        example: {
            webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x',
        },
        description: 'Provider-specific settings',
    })
    config: unknown;

    @ApiProperty({ example: true })
    enabled: boolean;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    createdAt: Date;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    updatedAt: Date;

    constructor(partial: Partial<NotificationChannelEntity>) {
        Object.assign(this, partial);
    }
}

export class NotificationLogEntity {
    @ApiProperty({ example: 'uuid-log' })
    id: string;

    @ApiProperty({ example: 'uuid-monitor' })
    monitorId: string;

    @ApiProperty({ example: 'uuid-channel' })
    channelId: string;

    @ApiProperty({ enum: ['SUCCESS', 'FAILED'], example: 'SUCCESS' })
    status: string;

    @ApiPropertyOptional({ example: 'HTTP 500 from open.feishu.cn' })
    error: string | null;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    sentAt: Date;

    constructor(partial: Partial<NotificationLogEntity>) {
        Object.assign(this, partial);
    }
}
