import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsOptional } from 'class-validator';
import { IsCuid } from '../../../common/decorators/is-cuid.decorator';

export class CreateCommentDto {
    @ApiProperty({ example: 'This looks good, but needs more tests.' })
    @IsNotEmpty()
    @IsString()
    body: string;

    @ApiPropertyOptional({
        example: 'cmgu92m5x0003p8l4h8z6s3k4',
        description: 'Parent comment ID for threaded reply',
    })
    @IsOptional()
    @IsCuid()
    parentId?: string;
}
