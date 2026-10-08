import {
    Body,
    Controller,
    Get,
    Post,
    Query,
    Res,
    StreamableFile,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
    ApiBearerAuth,
    ApiBadRequestResponse,
    ApiBody,
    ApiCreatedResponse,
    ApiForbiddenResponse,
    ApiOperation,
    ApiOkResponse,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import 'multer';
import type { Response } from 'express';
import { CurrentUser, SkipTransform } from '../../common/decorators';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { QueryPublicObjectDto, UploadAttachmentDto } from './dto';
import { PublicUploadEntity } from './entities';
import { AttachmentsService } from './attachments.service';

@ApiTags('Attachments')
@ApiBearerAuth('access-token')
@Controller('attachments')
export class PublicAttachmentsController {
    constructor(private readonly attachmentsService: AttachmentsService) {}

    @Get('object')
    @SkipTransform()
    @ApiOperation({ summary: 'Preview or download a general uploaded object' })
    @ApiOkResponse({ description: 'Object stream or redirect' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Object key is not accessible' })
    async object(
        @Query() query: QueryPublicObjectDto,
        @Res({ passthrough: true }) res: Response,
    ): Promise<StreamableFile | void> {
        const { filename, mimeType, download } =
            await this.attachmentsService.getPublicObjectDownload(
                query.key,
                query.provider,
                query.bucket,
            );

        if (download.type === 'redirect') {
            res.redirect(download.url);
            return;
        }

        res.setHeader('content-type', mimeType);
        res.setHeader(
            'content-disposition',
            `inline; filename="${encodeURIComponent(filename)}"`,
        );
        return new StreamableFile(download.stream);
    }

    @Post('upload')
    @UseInterceptors(
        FileInterceptor('file', {
            limits: { fileSize: 32 * 1024 * 1024, files: 1 },
        }),
    )
    @ApiOperation({
        summary: 'Upload a file without creating task attachment metadata',
    })
    @ApiBody({
        description: 'Multipart form with a file field named "file"',
        type: UploadAttachmentDto,
    })
    @ApiCreatedResponse({
        type: PublicUploadEntity,
        description: 'File uploaded to the active storage provider',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiBadRequestResponse({ description: 'Invalid or missing file' })
    async upload(
        @CurrentUser() user: JwtPayload,
        @Body() dto: UploadAttachmentDto,
        @UploadedFile() file?: Express.Multer.File,
    ) {
        return this.attachmentsService.uploadPublic(
            file,
            user.sub,
            dto.directory,
        );
    }
}
