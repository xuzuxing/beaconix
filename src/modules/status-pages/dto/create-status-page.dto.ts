import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsArray,
    IsBoolean,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    MinLength,
} from 'class-validator';

export const STATUS_PAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateStatusPageDto {
    @ApiProperty({ example: 'Acme status' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    title: string;

    @ApiPropertyOptional({
        example: 'acme-status',
        description:
            'Public URL slug. Leave empty to generate one from the title.',
    })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    @Matches(STATUS_PAGE_SLUG_PATTERN, {
        message:
            'slug may only contain lowercase letters, numbers and single hyphens',
    })
    slug?: string;

    @ApiPropertyOptional({ example: 'Public status for the Acme platform' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;

    @ApiPropertyOptional({
        type: [String],
        example: ['cmgu92m5x0005p8l4h8z6s3k6'],
        description:
            'Monitors shown on the public page. They must belong to this organization.',
    })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    visibleMonitorIds?: string[];

    @ApiPropertyOptional({ example: true, default: true })
    @IsOptional()
    @IsBoolean()
    showLatency?: boolean;

    @ApiPropertyOptional({ example: false, default: false })
    @IsOptional()
    @IsBoolean()
    showUptime?: boolean;

    @ApiPropertyOptional({ example: true, default: true })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;
}
