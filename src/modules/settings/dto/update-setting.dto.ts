import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsDefined,
    IsEnum,
    IsOptional,
    IsString,
    MaxLength,
} from 'class-validator';
import { SettingValueType } from '../../../generated/prisma/enums';

export class UpdateSettingDto {
    @ApiPropertyOptional({ example: 'Storage Driver' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    name?: string;

    @ApiProperty({
        oneOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'object' },
            { type: 'array', items: {} },
        ],
        examples: ['oss', 300, true, { enabled: true }],
    })
    @IsDefined()
    value: unknown;

    @ApiPropertyOptional({ enum: SettingValueType })
    @IsOptional()
    @IsEnum(SettingValueType)
    valueType?: SettingValueType;

    @ApiPropertyOptional({
        example: 'Active attachment storage driver: local or oss.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;

    @ApiPropertyOptional({ example: false })
    @IsOptional()
    @IsBoolean()
    isSecret?: boolean;
}
