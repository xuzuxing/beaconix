import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { BROWSER_URL_OPTIONS } from '../../../common/utils';

export class UpdateOrganizationDto {
    @ApiPropertyOptional({ example: 'Acme Corp Renamed' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    name?: string;

    @ApiPropertyOptional({ example: 'Updated description' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;

    @ApiPropertyOptional({ example: 'https://acme.com/new-logo.png' })
    @IsOptional()
    @IsUrl(BROWSER_URL_OPTIONS)
    logoUrl?: string;

    @ApiPropertyOptional({ example: 'https://acme.com' })
    @IsOptional()
    @IsUrl(BROWSER_URL_OPTIONS)
    website?: string;
}
