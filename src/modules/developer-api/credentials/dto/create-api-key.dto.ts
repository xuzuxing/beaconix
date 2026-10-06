import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ArrayMinSize,
    ArrayUnique,
    IsArray,
    IsDateString,
    IsIn,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';
import { API_SCOPES, ApiScope } from '../../common/scopes';

export class CreateApiKeyDto {
    @ApiProperty({
        example: 'Production CI',
        description: 'Human-friendly name',
    })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name: string;

    @ApiProperty({
        enum: API_SCOPES,
        isArray: true,
        example: ['monitors:read', 'monitors:write'],
        description: 'Scopes granted to this key',
    })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayUnique()
    @IsIn(API_SCOPES, { each: true })
    scopes: ApiScope[];

    @ApiPropertyOptional({
        example: '2026-12-31T23:59:59.000Z',
        description: 'Expiry timestamp; omit for a non-expiring key',
    })
    @IsOptional()
    @IsDateString()
    expiresAt?: string;
}
