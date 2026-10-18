import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsNotEmpty,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
} from 'class-validator';
import { IsBrowserUrl } from '../../../common/decorators';

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
    @IsBrowserUrl()
    logoUrl?: string;

    @ApiPropertyOptional({ example: 'https://acme.com' })
    @IsOptional()
    @IsBrowserUrl()
    website?: string;
}
