import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Param,
    Res,
    StreamableFile,
    HttpCode,
    HttpStatus,
    UseGuards,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
    ApiTags,
    ApiBearerAuth,
    ApiOperation,
    ApiParam,
    ApiBody,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiUnauthorizedResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiNoContentResponse,
} from '@nestjs/swagger';
import 'multer';
import type { Response } from 'express';
import { AttachmentsService } from './attachments.service';
import { SaveAttachmentDto, UploadAttachmentDto } from './dto';
import { AttachmentEntity } from './entities';
import { CurrentUser, AuditLog, SkipTransform } from '../../common/decorators';
import { ProjectAccessGuard } from '../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../common/authorization/project-permission.decorator';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';

@ApiTags('Attachments')
@ApiBearerAuth('access-token')
@Controller('tasks/:taskId/attachments')
@UseGuards(ProjectAccessGuard)
export class AttachmentsController {
    constructor(private readonly attachmentsService: AttachmentsService) {}

    @Get()
    @ProjectPermission('project.read', {
        resourceType: 'TASK',
        idParam: 'taskId',
    })
    @ApiOperation({ summary: 'List attachments for a task' })
    @ApiParam({ name: 'taskId', description: 'Task CUID' })
    @ApiOkResponse({ type: [AttachmentEntity], description: 'Attachment list' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member of the organization' })
    @ApiNotFoundResponse({ description: 'Task not found' })
    async findAll(
        @Param('taskId') taskId: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.attachmentsService.findAll(taskId, {
            type: 'USER',
            userId: user.sub,
        });
    }

    @Post('upload')
    @ProjectPermission('attachment.write', {
        resourceType: 'TASK',
        idParam: 'taskId',
    })
    @UseInterceptors(
        FileInterceptor('file', {
            limits: { fileSize: 32 * 1024 * 1024, files: 1 },
        }),
    )
    @AuditLog({ entity: 'Attachment' })
    @ApiOperation({ summary: 'Upload a file and save attachment metadata' })
    @ApiParam({ name: 'taskId', description: 'Task CUID' })
    @ApiBody({
        description: 'Multipart form with a file field named "file"',
        type: UploadAttachmentDto,
    })
    @ApiCreatedResponse({
        type: AttachmentEntity,
        description: 'Attachment uploaded and saved',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member of the organization' })
    @ApiNotFoundResponse({ description: 'Task not found' })
    async upload(
        @Param('taskId') taskId: string,
        @CurrentUser() user: JwtPayload,
        @UploadedFile() file?: Express.Multer.File,
    ) {
        return this.attachmentsService.upload(taskId, user.sub, file);
    }

    @Post()
    @ProjectPermission('attachment.write', {
        resourceType: 'TASK',
        idParam: 'taskId',
    })
    @AuditLog({ entity: 'Attachment' })
    @ApiOperation({
        summary: 'Save attachment metadata after external upload',
    })
    @ApiParam({ name: 'taskId', description: 'Task CUID' })
    @ApiBody({ type: SaveAttachmentDto })
    @ApiCreatedResponse({
        type: AttachmentEntity,
        description: 'Attachment saved',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member of the organization' })
    @ApiNotFoundResponse({ description: 'Task not found' })
    async save(
        @Param('taskId') taskId: string,
        @CurrentUser() user: JwtPayload,
        @Body() dto: SaveAttachmentDto,
    ) {
        return this.attachmentsService.save(taskId, user.sub, dto);
    }

    @Get(':id/download')
    @ProjectPermission('project.read', {
        resourceType: 'ATTACHMENT',
        idParam: 'id',
    })
    @SkipTransform()
    @ApiOperation({ summary: 'Download an attachment' })
    @ApiParam({ name: 'taskId', description: 'Task CUID' })
    @ApiParam({ name: 'id', description: 'Attachment CUID' })
    @ApiOkResponse({ description: 'Attachment stream or redirect' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member of the organization' })
    @ApiNotFoundResponse({ description: 'Attachment not found' })
    async download(
        @Param('taskId') taskId: string,
        @Param('id') attachmentId: string,
        @CurrentUser() user: JwtPayload,
        @Res({ passthrough: true }) res: Response,
    ): Promise<StreamableFile | void> {
        const { attachment, download } =
            await this.attachmentsService.getDownload(taskId, attachmentId, {
                type: 'USER',
                userId: user.sub,
            });
        res.setHeader('cache-control', 'private, no-store');

        if (download.type === 'redirect') {
            res.redirect(download.url);
            return;
        }

        res.setHeader('content-type', attachment.mimeType);
        res.setHeader(
            'content-disposition',
            `attachment; filename="${encodeURIComponent(attachment.filename)}"`,
        );
        return new StreamableFile(download.stream);
    }

    @Delete(':id')
    @ProjectPermission('attachment.write', {
        resourceType: 'ATTACHMENT',
        idParam: 'id',
    })
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Remove an attachment (uploader or ADMIN+)' })
    @ApiParam({ name: 'taskId', description: 'Task CUID' })
    @ApiParam({ name: 'id', description: 'Attachment CUID' })
    @ApiNoContentResponse({ description: 'Attachment removed from DB and CDN' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not uploader or admin' })
    @ApiNotFoundResponse({ description: 'Attachment not found' })
    async remove(
        @Param('taskId') taskId: string,
        @Param('id') attachmentId: string,
        @CurrentUser() user: JwtPayload,
    ) {
        await this.attachmentsService.remove(taskId, attachmentId, user.sub);
    }
}
