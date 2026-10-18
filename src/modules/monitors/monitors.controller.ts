import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Body,
    Param,
    HttpCode,
    HttpStatus,
    UseGuards,
} from '@nestjs/common';
import {
    ApiTags,
    ApiBearerAuth,
    ApiOperation,
    ApiParam,
    ApiBody,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiBadRequestResponse,
    ApiUnauthorizedResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { MonitorsService } from './monitors.service';
import { CreateMonitorDto, SetMonitorProbesDto, UpdateMonitorDto } from './dto';
import { MonitorEntity } from './entities';
import { AuditLog } from '../../common/decorators';
import { ProjectAccessGuard } from '../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../common/authorization/project-permission.decorator';
import { CurrentPrincipal } from '../../common/authorization/current-principal.decorator';
import type { AccessPrincipal } from '../../common/authorization/access.types';

@ApiTags('Monitors')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/monitors')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('monitor.manage', { resourceType: 'MONITOR', idParam: 'id' })
export class MonitorsController {
    constructor(private readonly monitorsService: MonitorsService) {}

    @Get()
    @ProjectPermission('monitor.read', {
        resourceType: 'PROJECT',
        idParam: 'projectId',
    })
    @ApiOperation({ summary: 'List all monitors in the project' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiOkResponse({
        type: [MonitorEntity],
        description: 'List of monitors',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    async findAll(
        @Param('projectId') projectId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.monitorsService.findAll(projectId, principal);
    }

    @Post()
    @ProjectPermission('monitor.manage', {
        resourceType: 'PROJECT',
        idParam: 'projectId',
    })
    @AuditLog({ entity: 'Monitor' })
    @ApiOperation({ summary: 'Create a new monitor' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiBody({ type: CreateMonitorDto })
    @ApiCreatedResponse({
        type: MonitorEntity,
        description: 'Monitor created',
    })
    @ApiServiceUnavailableResponse({
        description: 'Monitor credential encryption is not configured',
    })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    async create(
        @Param('projectId') projectId: string,
        @Body() dto: CreateMonitorDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.monitorsService.create(projectId, dto, principal);
    }

    @Get(':id')
    @ProjectPermission('monitor.read', {
        resourceType: 'MONITOR',
        idParam: 'id',
    })
    @ApiOperation({ summary: 'Get monitor by ID' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Monitor CUID' })
    @ApiOkResponse({
        type: MonitorEntity,
        description: 'Monitor details',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async findOne(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.monitorsService.findOne(projectId, id, principal);
    }

    @Patch(':id')
    @AuditLog({ entity: 'Monitor' })
    @ApiOperation({ summary: 'Update monitor' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Monitor CUID' })
    @ApiBody({ type: UpdateMonitorDto })
    @ApiOkResponse({
        type: MonitorEntity,
        description: 'Monitor updated',
    })
    @ApiServiceUnavailableResponse({
        description: 'Monitor credential encryption is not configured',
    })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async update(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
        @Body() dto: UpdateMonitorDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.monitorsService.update(projectId, id, dto, principal);
    }

    @Patch(':id/probes')
    @AuditLog({ entity: 'Monitor', action: 'ASSIGN' })
    @ApiOperation({
        summary: 'Assign the tenant probes of this monitor (replaces the set)',
    })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Monitor CUID' })
    @ApiBody({ type: SetMonitorProbesDto })
    @ApiOkResponse({
        type: MonitorEntity,
        description: 'Probe assignments replaced',
    })
    @ApiBadRequestResponse({
        description:
            'Validation failed, or a probe does not belong to this organization',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({
        description:
            'Insufficient role, or the plan per-monitor probe limit is exceeded',
    })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async setProbes(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
        @Body() dto: SetMonitorProbesDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.monitorsService.setProbes(projectId, id, dto, principal);
    }

    @Post(':id/pause')
    @HttpCode(HttpStatus.OK)
    // AuditAction has no PAUSE value, so the toggle is logged as an update.
    @AuditLog({ entity: 'Monitor', action: 'UPDATE' })
    @ApiOperation({
        summary: 'Pause monitor (stops scheduling checks)',
    })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Monitor CUID' })
    @ApiOkResponse({
        type: MonitorEntity,
        description: 'Monitor paused',
    })
    @ApiBadRequestResponse({ description: 'Monitor is already paused' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async pause(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.monitorsService.pause(projectId, id, principal);
    }

    @Post(':id/resume')
    @HttpCode(HttpStatus.OK)
    @AuditLog({ entity: 'Monitor', action: 'UPDATE' })
    @ApiOperation({ summary: 'Resume a paused monitor' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Monitor CUID' })
    @ApiOkResponse({
        type: MonitorEntity,
        description: 'Monitor resumed',
    })
    @ApiBadRequestResponse({ description: 'Monitor is not paused' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async resume(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.monitorsService.resume(projectId, id, principal);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    @AuditLog({ entity: 'Monitor', action: 'DELETE' })
    @ApiOperation({ summary: 'Soft delete monitor' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Monitor CUID' })
    @ApiOkResponse({
        type: MonitorEntity,
        description: 'Monitor soft-deleted',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async remove(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.monitorsService.softDelete(projectId, id, principal);
    }

    @Post(':id/restore')
    @HttpCode(HttpStatus.OK)
    @ProjectPermission('monitor.restore', {
        resourceType: 'MONITOR',
        idParam: 'id',
    })
    @AuditLog({ entity: 'Monitor', action: 'RESTORE' })
    @ApiOperation({ summary: 'Restore a soft-deleted monitor' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Monitor CUID' })
    @ApiOkResponse({
        type: MonitorEntity,
        description: 'Monitor restored',
    })
    @ApiBadRequestResponse({ description: 'Monitor is not deleted' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async restore(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.monitorsService.restore(projectId, id, principal);
    }

    @Post(':id/test-alert')
    @HttpCode(HttpStatus.OK)
    @ProjectPermission('monitor.test-alert', {
        resourceType: 'MONITOR',
        idParam: 'id',
    })
    @ApiOperation({
        summary: 'Send a test availability alert to the bound channels',
    })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Monitor CUID' })
    @ApiOkResponse({ description: 'Test alert delivery result' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async sendTestAlert(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.monitorsService.sendTestAlert(projectId, id, principal);
    }
}
