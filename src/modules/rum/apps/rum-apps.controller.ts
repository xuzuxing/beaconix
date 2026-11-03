import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
} from '@nestjs/swagger';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { CurrentPrincipal } from '../../../common/authorization/current-principal.decorator';
import { ProjectAccessGuard } from '../../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../../common/authorization/project-permission.decorator';
import { AuditLog } from '../../../common/decorators';
import { CreateRumAppDto, UpdateRumAppDto } from '../dto';
import { RumAppEntity } from '../entities';
import { RumAppsService } from './rum-apps.service';

@ApiTags('RUM Apps')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/apps')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('app.manage', {
    resourceType: 'RUM_APP',
    idParam: 'appId',
})
export class RumAppsController {
    constructor(private readonly apps: RumAppsService) {}

    @Get()
    @ProjectPermission('app.read', {
        resourceType: 'PROJECT',
        idParam: 'projectId',
    })
    @ApiOperation({ summary: 'List RUM apps in a project' })
    @ApiOkResponse({ type: [RumAppEntity] })
    findAll(
        @Param('projectId') projectId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.apps.findAll(projectId, principal);
    }

    @Post()
    @ProjectPermission('app.manage', {
        resourceType: 'PROJECT',
        idParam: 'projectId',
    })
    @AuditLog({ entity: 'RumApp' })
    @ApiOperation({ summary: 'Create a RUM app in a project' })
    @ApiCreatedResponse({ type: RumAppEntity })
    @ApiForbiddenResponse({ description: 'Project ADMIN required' })
    create(
        @Param('projectId') projectId: string,
        @Body() dto: CreateRumAppDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.apps.create(projectId, dto, principal);
    }

    @Get(':appId')
    @ProjectPermission('app.read', {
        resourceType: 'RUM_APP',
        idParam: 'appId',
    })
    @ApiOperation({ summary: 'Get a RUM app' })
    @ApiParam({ name: 'appId', description: 'RUM app CUID' })
    @ApiOkResponse({ type: RumAppEntity })
    @ApiNotFoundResponse({ description: 'RUM app not found' })
    findOne(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.apps.findOne(projectId, appId, principal);
    }

    @Patch(':appId')
    @AuditLog({ entity: 'RumApp', idParam: 'appId' })
    @ApiOperation({ summary: 'Update a RUM app' })
    @ApiOkResponse({ type: RumAppEntity })
    update(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Body() dto: UpdateRumAppDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.apps.update(projectId, appId, dto, principal);
    }

    @Post(':appId/disable')
    @HttpCode(HttpStatus.OK)
    @AuditLog({ entity: 'RumApp', idParam: 'appId', action: 'UPDATE' })
    @ApiOperation({ summary: 'Disable RUM ingestion for an app' })
    @ApiOkResponse({ type: RumAppEntity })
    disable(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.apps.setEnabled(projectId, appId, false, principal);
    }

    @Post(':appId/enable')
    @HttpCode(HttpStatus.OK)
    @AuditLog({ entity: 'RumApp', idParam: 'appId', action: 'UPDATE' })
    @ApiOperation({ summary: 'Enable RUM ingestion for an app' })
    @ApiOkResponse({ type: RumAppEntity })
    enable(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.apps.setEnabled(projectId, appId, true, principal);
    }
}
