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
} from '@nestjs/swagger';
import { MonitorsService } from './monitors.service';
import { CreateMonitorDto, UpdateMonitorDto } from './dto';
import { MonitorEntity } from './entities';
import { Roles, AuditLog } from '../../common/decorators';
import { RolesGuard, OrgMemberGuard } from '../../common/guards';

@ApiTags('Monitors')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/monitors')
export class MonitorsController {
    constructor(private readonly monitorsService: MonitorsService) {}

    @Get()
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'List all monitors in the project' })
    @ApiParam({ name: 'projectId', description: 'Project UUID' })
    @ApiOkResponse({
        type: [MonitorEntity],
        description: 'List of monitors',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    async findAll(@Param('projectId') projectId: string) {
        return this.monitorsService.findAll(projectId);
    }

    @Post()
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'Monitor' })
    @ApiOperation({ summary: 'Create a new monitor' })
    @ApiParam({ name: 'projectId', description: 'Project UUID' })
    @ApiBody({ type: CreateMonitorDto })
    @ApiCreatedResponse({
        type: MonitorEntity,
        description: 'Monitor created',
    })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    async create(
        @Param('projectId') projectId: string,
        @Body() dto: CreateMonitorDto,
    ) {
        return this.monitorsService.create(projectId, dto);
    }

    @Get(':id')
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'Get monitor by ID' })
    @ApiParam({ name: 'projectId', description: 'Project UUID' })
    @ApiParam({ name: 'id', description: 'Monitor UUID' })
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
    ) {
        return this.monitorsService.findOne(projectId, id);
    }

    @Patch(':id')
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'Monitor' })
    @ApiOperation({ summary: 'Update monitor' })
    @ApiParam({ name: 'projectId', description: 'Project UUID' })
    @ApiParam({ name: 'id', description: 'Monitor UUID' })
    @ApiBody({ type: UpdateMonitorDto })
    @ApiOkResponse({
        type: MonitorEntity,
        description: 'Monitor updated',
    })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async update(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
        @Body() dto: UpdateMonitorDto,
    ) {
        return this.monitorsService.update(projectId, id, dto);
    }

    @Post(':id/pause')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    // AuditAction has no PAUSE value, so the toggle is logged as an update.
    @AuditLog({ entity: 'Monitor', action: 'UPDATE' })
    @ApiOperation({
        summary: 'Pause monitor (stops scheduling checks)',
    })
    @ApiParam({ name: 'projectId', description: 'Project UUID' })
    @ApiParam({ name: 'id', description: 'Monitor UUID' })
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
    ) {
        return this.monitorsService.pause(projectId, id);
    }

    @Post(':id/resume')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'Monitor', action: 'UPDATE' })
    @ApiOperation({ summary: 'Resume a paused monitor' })
    @ApiParam({ name: 'projectId', description: 'Project UUID' })
    @ApiParam({ name: 'id', description: 'Monitor UUID' })
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
    ) {
        return this.monitorsService.resume(projectId, id);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'Monitor', action: 'DELETE' })
    @ApiOperation({ summary: 'Soft delete monitor' })
    @ApiParam({ name: 'projectId', description: 'Project UUID' })
    @ApiParam({ name: 'id', description: 'Monitor UUID' })
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
    ) {
        return this.monitorsService.softDelete(projectId, id);
    }

    @Post(':id/restore')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'Monitor', action: 'RESTORE' })
    @ApiOperation({ summary: 'Restore a soft-deleted monitor' })
    @ApiParam({ name: 'projectId', description: 'Project UUID' })
    @ApiParam({ name: 'id', description: 'Monitor UUID' })
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
    ) {
        return this.monitorsService.restore(projectId, id);
    }
}
