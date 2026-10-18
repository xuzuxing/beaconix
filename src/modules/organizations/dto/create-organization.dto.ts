import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsNotEmpty,
    IsOptional,
    IsString,
    IsUrl,
    Matches,
    MaxLength,
} from 'class-validator';
import { BROWSER_URL_OPTIONS } from '../../../common/utils';

export class CreateOrganizationDto {
    @ApiProperty({ example: 'Acme Corporation' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    name: string;

    @ApiProperty({
        example: 'acme-corp',
        description: 'URL-safe identifier (lowercase, hyphens, no spaces)',
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(50)
    @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
        message:
            'Slug must be lowercase alphanumeric with hyphens (e.g. acme-corp)',
    })
    slug: string;

    @ApiPropertyOptional({ example: 'Building amazing products' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;

    @ApiPropertyOptional({ example: 'https://acme.com/logo.png' })
    @IsOptional()
    @IsUrl(BROWSER_URL_OPTIONS)
    logoUrl?: string;

    @ApiPropertyOptional({ example: 'https://acme.com' })
    @IsOptional()
    @IsUrl(BROWSER_URL_OPTIONS)
    website?: string;
}
