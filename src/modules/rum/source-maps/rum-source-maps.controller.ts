import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    UploadedFile,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
    ApiBearerAuth,
    ApiConsumes,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import 'multer';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { CurrentPrincipal } from '../../../common/authorization/current-principal.decorator';
import { ProjectAccessGuard } from '../../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../../common/authorization/project-permission.decorator';
import { UploadRumSourceMapDto } from '../dto';
import { RumSourceMapsService } from './rum-source-maps.service';

@ApiTags('RUM Source Maps')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/apps/:appId/source-maps')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('app.manage', {
    resourceType: 'RUM_APP',
    idParam: 'appId',
})
export class RumSourceMapsController {
    constructor(private readonly sourceMaps: RumSourceMapsService) {}

    @Get()
    @ProjectPermission('app.read', {
        resourceType: 'RUM_APP',
        idParam: 'appId',
    })
    @ApiOperation({ summary: 'List uploaded source maps for a RUM app' })
    findAll(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.sourceMaps.findAll(projectId, appId, principal);
    }

    @Post()
    @ApiConsumes('multipart/form-data')
    @UseInterceptors(
        FileInterceptor('file', {
            limits: { fileSize: 5 * 1024 * 1024, files: 1 },
        }),
    )
    @ApiOperation({ summary: 'Upload or replace a Source Map v3 file' })
    upload(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Body() dto: UploadRumSourceMapDto,
        @UploadedFile() file: Express.Multer.File | undefined,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.sourceMaps.upload(projectId, appId, dto, file, principal);
    }

    @Delete(':sourceMapId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Delete a source map' })
    remove(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Param('sourceMapId') sourceMapId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.sourceMaps.remove(projectId, appId, sourceMapId, principal);
    }
}
