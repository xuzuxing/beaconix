import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsEnum,
    IsObject,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';
import { NotificationChannelType } from '../../../generated/prisma/enums';
import type { InputJsonValue } from '../../../generated/prisma/internal/prismaNamespace';

export class CreateNotificationChannelDto {
    @ApiProperty({
        enum: NotificationChannelType,
        example: NotificationChannelType.FEISHU,
        description: 'Delivery provider',
    })
    @IsEnum(NotificationChannelType)
    type: NotificationChannelType;

    @ApiProperty({ example: 'Platform alerts' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name: string;

    @ApiProperty({
        example: {
            webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxx',
            secret: 'optional-signing-secret',
        },
        description:
            'Provider-specific settings. FEISHU/WECOM/DINGTALK: { webhookUrl, secret? }. ' +
            'WECHAT_SUBSCRIBE: { appId, appSecret, templateId, openIds, page?, fields? }. ' +
            'EMAIL: { to: string[] }.',
    })
    @IsObject()
    config: InputJsonValue;

    @ApiPropertyOptional({
        example: true,
        description: 'Whether the channel receives monitor alerts',
        default: true,
    })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;
}
