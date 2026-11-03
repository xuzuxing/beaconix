import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsEnum,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';
import { RumAppPlatform } from '../../../generated/prisma/enums';

export class CreateRumAppDto {
    @ApiProperty({ example: 'Customer portal' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name: string;

    @ApiPropertyOptional({ enum: RumAppPlatform, default: RumAppPlatform.WEB })
    @IsOptional()
    @IsEnum(RumAppPlatform)
    platform?: RumAppPlatform;
}
