import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsBrowserUrl } from '../../../common/decorators';

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
    @IsBrowserUrl()
    logoUrl?: string;

    @ApiPropertyOptional({ example: 'https://acme.com' })
    @IsOptional()
    @IsBrowserUrl()
    website?: string;
}
