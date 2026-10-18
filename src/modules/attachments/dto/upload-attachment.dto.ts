import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

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

    @ApiPropertyOptional({
        example: 'avatars',
        description:
            'Optional directory for general uploads (`avatars`, `uploads`, …). ' +
            'Empty defaults to `uploads`. `tickets` is the one private ' +
            'directory this endpoint accepts.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(160)
    directory?: string;
}
