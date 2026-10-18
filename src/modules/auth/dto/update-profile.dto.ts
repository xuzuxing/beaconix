import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { BROWSER_URL_OPTIONS } from '../../../common/utils';

export class UpdateProfileDto {
    @ApiPropertyOptional({ example: 'Jane Doe' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    name?: string;

    @ApiPropertyOptional({ example: 'https://example.com/avatar.png' })
    @IsOptional()
    @IsUrl(BROWSER_URL_OPTIONS)
    avatarUrl?: string;
}
