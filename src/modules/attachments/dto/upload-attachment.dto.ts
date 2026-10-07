import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

export class UploadAttachmentDto {
    @ApiPropertyOptional({
        enum: ['UPLOAD'],
        default: 'UPLOAD',
        description:
            'Uploaded file source. Multipart uploads always use UPLOAD.',
    })
    @IsOptional()
    @IsEnum(['UPLOAD'])
    source?: 'UPLOAD';
}
