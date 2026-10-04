import { ApiPropertyOptional } from '@nestjs/swagger';
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

export class UpdateNotificationChannelDto {
    @ApiPropertyOptional({
        enum: NotificationChannelType,
        example: NotificationChannelType.DINGTALK,
    })
    @IsOptional()
    @IsEnum(NotificationChannelType)
    type?: NotificationChannelType;

    @ApiPropertyOptional({ example: 'Platform alerts (secondary)' })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name?: string;

    @ApiPropertyOptional({
        example: {
            webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=x',
        },
        description: 'Replaces the stored config when provided',
    })
    @IsOptional()
    @IsObject()
    config?: InputJsonValue;

    @ApiPropertyOptional({ example: false })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;
}
