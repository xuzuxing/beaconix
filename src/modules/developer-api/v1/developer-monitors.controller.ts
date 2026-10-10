import {
    Body,
    Controller,
    Delete,
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
    ApiBody,
    ApiCreatedResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AuditLog, Public } from '../../../common/decorators';
import { CreateMonitorDto, UpdateMonitorDto } from '../../monitors/dto';
import { MonitorEntity } from '../../monitors/entities';
import { MonitorsService } from '../../monitors/monitors.service';
import { DeveloperAuthGuard } from '../auth/developer-auth.guard';
import { RequireScopes } from '../auth/require-scopes.decorator';

@ApiTags('Developer API - Monitors')
@ApiBearerAuth('developer-api-key')
@Controller('developer/v1')
@SkipThrottle({ default: true })
export class DeveloperMonitorsController {
    constructor(private readonly monitorsService: MonitorsService) {}

    @Get('organizations/:orgId/monitors')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('monitors:read')
    @ApiOperation({ summary: 'List every monitor in the organization' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiOkResponse({ type: [MonitorEntity] })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    async findAllByOrg(@Param('orgId') orgId: string) {
        return this.monitorsService.findAllByOrg(orgId);
    }

    @Get('projects/:projectId/monitors')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('monitors:read')
    @ApiOperation({ summary: 'List monitors in a project' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiOkResponse({ type: [MonitorEntity] })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    async findAll(@Param('projectId') projectId: string) {
        return this.monitorsService.findAll(projectId);
    }

    @Post('projects/:projectId/monitors')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('monitors:write')
    @AuditLog({ entity: 'Monitor' })
    @ApiOperation({ summary: 'Create a monitor' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiBody({ type: CreateMonitorDto })
    @ApiCreatedResponse({ type: MonitorEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    async create(
        @Param('projectId') projectId: string,
        @Body() dto: CreateMonitorDto,
    ) {
        return this.monitorsService.create(projectId, dto);
    }

    @Get('projects/:projectId/monitors/:id')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('monitors:read')
    @ApiOperation({ summary: 'Get a monitor' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Monitor CUID' })
    @ApiOkResponse({ type: MonitorEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async findOne(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
    ) {
        return this.monitorsService.findOne(projectId, id);
    }

    @Patch('projects/:projectId/monitors/:id')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('monitors:write')
    @AuditLog({ entity: 'Monitor' })
    @ApiOperation({ summary: 'Update a monitor' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Monitor CUID' })
    @ApiBody({ type: UpdateMonitorDto })
    @ApiOkResponse({ type: MonitorEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async update(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
        @Body() dto: UpdateMonitorDto,
    ) {
        return this.monitorsService.update(projectId, id, dto);
    }

    @Post('projects/:projectId/monitors/:id/pause')
    @HttpCode(HttpStatus.OK)
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('monitors:write')
    @AuditLog({ entity: 'Monitor', action: 'UPDATE' })
    @ApiOperation({ summary: 'Pause a monitor' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Monitor CUID' })
    @ApiOkResponse({ type: MonitorEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async pause(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
    ) {
        return this.monitorsService.pause(projectId, id);
    }

    @Post('projects/:projectId/monitors/:id/resume')
    @HttpCode(HttpStatus.OK)
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('monitors:write')
    @AuditLog({ entity: 'Monitor', action: 'UPDATE' })
    @ApiOperation({ summary: 'Resume a monitor' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Monitor CUID' })
    @ApiOkResponse({ type: MonitorEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async resume(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
    ) {
        return this.monitorsService.resume(projectId, id);
    }

    @Delete('projects/:projectId/monitors/:id')
    @HttpCode(HttpStatus.OK)
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('monitors:write')
    @AuditLog({ entity: 'Monitor', action: 'DELETE' })
    @ApiOperation({ summary: 'Soft delete a monitor' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Monitor CUID' })
    @ApiOkResponse({ type: MonitorEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async remove(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
    ) {
        return this.monitorsService.softDelete(projectId, id);
    }

    @Post('projects/:projectId/monitors/:id/restore')
    @HttpCode(HttpStatus.OK)
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('monitors:write')
    @AuditLog({ entity: 'Monitor', action: 'RESTORE' })
    @ApiOperation({ summary: 'Restore a soft-deleted monitor' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Monitor CUID' })
    @ApiOkResponse({ type: MonitorEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async restore(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
    ) {
        return this.monitorsService.restore(projectId, id);
    }
}
