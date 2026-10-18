import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsBrowserUrl } from '../../../common/decorators';

export class UpdateProfileDto {
    @ApiPropertyOptional({ example: 'Jane Doe' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    name?: string;

    @ApiPropertyOptional({ example: 'https://example.com/avatar.png' })
    @IsOptional()
    @IsBrowserUrl()
    avatarUrl?: string;
}
