import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PublicUploadEntity {
    @ApiProperty({ example: 'design-spec.pdf' })
    filename: string;

    @ApiProperty({ example: 'application/pdf' })
    mimeType: string;

    @ApiProperty({ example: 1048576 })
    size: number;

    @ApiProperty({
        enum: ['LOCAL', 'OSS'],
        example: 'LOCAL',
    })
    storageProvider: string;

    @ApiPropertyOptional({ example: 'beacon-attachments' })
    bucket?: string;

    @ApiProperty({
        example: 'organizations/public/tasks/public/2026/10/file.pdf',
    })
    fileKey: string;

    @ApiProperty({
        example:
            'https://cdn.example.com/organizations/public/tasks/public/2026/10/file.pdf',
    })
    url: string;

    @ApiPropertyOptional({ example: 'sha256 hex digest' })
    checksum?: string;

    @ApiProperty({ example: 'user_xxx' })
    uploadedById: string;

    constructor(partial: Partial<PublicUploadEntity>) {
        Object.assign(this, partial);
    }
}
