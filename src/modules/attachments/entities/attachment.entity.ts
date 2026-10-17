import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AttachmentEntity {
    @ApiProperty({ example: 'uuid-attachment' })
    id: string;

    @ApiProperty({ example: 'design-spec.pdf' })
    filename: string;

    @ApiProperty({ example: 'application/pdf' })
    mimeType: string;

    @ApiProperty({ example: 1048576 })
    size: number;

    @ApiProperty({
        example: '/api/tasks/task_xxx/attachments/att_xxx/download',
    })
    url: string;

    @ApiPropertyOptional({
        example: 'organizations/org_xxx/tasks/task_xxx/2026/10/file.pdf',
    })
    fileKey: string | null;

    @ApiProperty({
        enum: ['LOCAL', 'OSS', 'EXTERNAL'],
        example: 'LOCAL',
    })
    storageProvider: string;

    @ApiPropertyOptional({ example: 'beaconix-attachments' })
    bucket: string | null;

    @ApiPropertyOptional({ example: 'sha256 hex digest' })
    checksum: string | null;

    @ApiProperty({
        enum: ['UPLOAD', 'GOOGLE_DRIVE', 'DROPBOX', 'URL'],
        example: 'UPLOAD',
    })
    source: string;

    @ApiPropertyOptional({
        example: 'uuid-task',
        nullable: true,
        description:
            'Host task; ticket attachments leave this null and use ticketId / ticketReplyId',
    })
    taskId: string | null;

    @ApiPropertyOptional({ example: 'uuid-uploader' })
    uploadedById: string | null;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    createdAt: Date;

    // Optional relation
    uploadedBy?: { id: string; name: string } | null;

    constructor(partial: Partial<AttachmentEntity>) {
        Object.assign(this, partial);
    }
}
