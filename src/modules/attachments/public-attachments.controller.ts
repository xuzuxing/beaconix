import {
    Controller,
    Post,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
    ApiBearerAuth,
    ApiBadRequestResponse,
    ApiBody,
    ApiCreatedResponse,
    ApiOperation,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import 'multer';
import { CurrentUser } from '../../common/decorators';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { UploadAttachmentDto } from './dto';
import { PublicUploadEntity } from './entities';
import { AttachmentsService } from './attachments.service';

@ApiTags('Attachments')
@ApiBearerAuth('access-token')
@Controller('attachments')
export class PublicAttachmentsController {
    constructor(private readonly attachmentsService: AttachmentsService) {}

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
        @UploadedFile() file?: Express.Multer.File,
    ) {
        return this.attachmentsService.uploadPublic(file, user.sub);
    }
}
