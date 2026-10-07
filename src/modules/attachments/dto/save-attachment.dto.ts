import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsNotEmpty,
    IsString,
    IsOptional,
    IsInt,
    IsEnum,
    IsUrl,
    MaxLength,
} from 'class-validator';

export class SaveAttachmentDto {
    @ApiProperty({ example: 'design-spec.pdf' })
    @IsNotEmpty()
    @IsString()
    filename: string;

    @ApiProperty({ example: 'application/pdf' })
    @IsNotEmpty()
    @IsString()
    mimeType: string;

    @ApiProperty({ example: 1048576, description: 'File size in bytes' })
    @IsNotEmpty()
    @IsInt()
    size: number;

    @ApiProperty({
        example: '/api/tasks/task_xxx/attachments/att_xxx/download',
    })
    @IsNotEmpty()
    @IsUrl()
    url: string;

    @ApiPropertyOptional({
        example: 'abc123',
        description: 'Storage object key for deletion/download',
    })
    @IsOptional()
    @IsString()
    @MaxLength(512)
    fileKey?: string;

    @ApiPropertyOptional({
        enum: ['UPLOAD', 'GOOGLE_DRIVE', 'DROPBOX', 'URL'],
        default: 'UPLOAD',
    })
    @IsOptional()
    @IsEnum(['UPLOAD', 'GOOGLE_DRIVE', 'DROPBOX', 'URL'])
    source?: string;

    @ApiPropertyOptional({
        enum: ['LOCAL', 'OSS', 'EXTERNAL'],
        description: 'Storage provider for the object key',
    })
    @IsOptional()
    @IsEnum(['LOCAL', 'OSS', 'EXTERNAL'])
    storageProvider?: string;

    @ApiPropertyOptional({ example: 'beacon-attachments' })
    @IsOptional()
    @IsString()
    @MaxLength(512)
    bucket?: string;

    @ApiPropertyOptional({ example: 'sha256:...' })
    @IsOptional()
    @IsString()
    @MaxLength(256)
    checksum?: string;
}
