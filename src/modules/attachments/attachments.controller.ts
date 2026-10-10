import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Param,
    Req,
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
import { OrgMemberGuard } from '../../common/guards';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';

@ApiTags('Attachments')
@ApiBearerAuth('access-token')
@Controller('tasks/:taskId/attachments')
export class AttachmentsController {
    constructor(private readonly attachmentsService: AttachmentsService) {}

    @Get()
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'List attachments for a task' })
    @ApiParam({ name: 'taskId', description: 'Task CUID' })
    @ApiOkResponse({ type: [AttachmentEntity], description: 'Attachment list' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member of the organization' })
    @ApiNotFoundResponse({ description: 'Task not found' })
    async findAll(@Param('taskId') taskId: string) {
        return this.attachmentsService.findAll(taskId);
    }

    @Post('upload')
    @UseGuards(OrgMemberGuard)
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
    @UseGuards(OrgMemberGuard)
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
    @UseGuards(OrgMemberGuard)
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
        @Res({ passthrough: true }) res: Response,
    ): Promise<StreamableFile | void> {
        const { attachment, download } =
            await this.attachmentsService.getDownload(taskId, attachmentId);

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
    @UseGuards(OrgMemberGuard)
    @HttpCode(HttpStatus.NO_CONTENT)
    @AuditLog({ entity: 'Attachment', action: 'DELETE' })
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
        @Req() req: any,
    ) {
        const role = req['membership']?.role ?? 'VIEWER';
        await this.attachmentsService.remove(
            taskId,
            attachmentId,
            user.sub,
            role,
        );
    }
}
