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

export class CreatePersonalAccessTokenDto {
    @ApiProperty({ example: 'My laptop', description: 'Human-friendly name' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name: string;

    @ApiPropertyOptional({
        enum: API_SCOPES,
        isArray: true,
        description:
            'Reserved for future scope enforcement. PATs currently carry the same permissions as the user.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMinSize(1)
    @ArrayUnique()
    @IsIn(API_SCOPES, { each: true })
    scopes?: ApiScope[];

    @ApiPropertyOptional({
        example: '2026-12-31T23:59:59.000Z',
        description: 'Expiry timestamp; omit for the default 30-day expiry',
    })
    @IsOptional()
    @IsDateString()
    expiresAt?: string;
}
