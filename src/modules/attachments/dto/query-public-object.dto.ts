import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    MaxLength,
} from 'class-validator';

export class QueryPublicObjectDto {
    @ApiProperty({
        example: 'openchoreo/2026/10/object-file.png',
    })
    @IsString()
    @MaxLength(1024)
    key: string;

    @ApiPropertyOptional({ enum: ['LOCAL', 'OSS'], example: 'LOCAL' })
    @IsOptional()
    @IsEnum(['LOCAL', 'OSS'])
    provider?: 'LOCAL' | 'OSS';

    @ApiPropertyOptional({ example: 'beaconix-attachments' })
    @IsOptional()
    @IsString()
    @MaxLength(512)
    bucket?: string;

    @ApiPropertyOptional({
        description: 'Signed link expiry (unix seconds); set together with sig',
        example: 1760000000,
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    exp?: number;

    @ApiPropertyOptional({
        description: 'Signed link signature issued by the API',
    })
    @IsOptional()
    @IsString()
    @MaxLength(128)
    sig?: string;
}
