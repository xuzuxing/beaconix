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
    ApiNoContentResponse,
} from '@nestjs/swagger';
import { SprintsService } from './sprints.service';
import { CreateSprintDto, UpdateSprintDto } from './dto';
import { SprintEntity } from './entities';
import { AuditLog, CurrentUser } from '../../common/decorators';
import { ProjectAccessGuard } from '../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../common/authorization/project-permission.decorator';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';

@ApiTags('Sprints')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/sprints')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('sprint.manage', { resourceType: 'SPRINT', idParam: 'id' })
export class SprintsController {
    constructor(private readonly sprintsService: SprintsService) {}

    @Get()
    @ProjectPermission('project.read', {
        resourceType: 'PROJECT',
        idParam: 'projectId',
    })
    @ApiOperation({ summary: 'List all sprints in a project' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiOkResponse({
        type: [SprintEntity],
        description: 'List of sprints ordered by display order',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member of the organization' })
    @ApiNotFoundResponse({ description: 'Project not found' })
    async findAll(
        @Param('projectId') projectId: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.sprintsService.findAll(projectId, {
            type: 'USER',
            userId: user.sub,
        });
    }

    @Post()
    @ProjectPermission('sprint.manage', {
        resourceType: 'PROJECT',
        idParam: 'projectId',
    })
    @AuditLog({ entity: 'Sprint' })
    @ApiOperation({ summary: 'Create a new sprint' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiBody({ type: CreateSprintDto })
    @ApiCreatedResponse({
        type: SprintEntity,
        description: 'Sprint created',
    })
    @ApiBadRequestResponse({
        description: 'Validation failed or project is archived',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Project not found' })
    async create(
        @Param('projectId') projectId: string,
        @Body() dto: CreateSprintDto,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.sprintsService.create(projectId, dto, user.sub);
    }

    @Get(':id')
    @ProjectPermission('project.read', {
        resourceType: 'SPRINT',
        idParam: 'id',
    })
    @ApiOperation({ summary: 'Get sprint by ID' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Sprint CUID' })
    @ApiOkResponse({
        type: SprintEntity,
        description: 'Sprint details',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member of the organization' })
    @ApiNotFoundResponse({ description: 'Sprint not found' })
    async findOne(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.sprintsService.findOne(projectId, id, {
            type: 'USER',
            userId: user.sub,
        });
    }

    @Patch(':id')
    @AuditLog({ entity: 'Sprint' })
    @ApiOperation({ summary: 'Update sprint details' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Sprint CUID' })
    @ApiBody({ type: UpdateSprintDto })
    @ApiOkResponse({
        type: SprintEntity,
        description: 'Sprint updated',
    })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Sprint not found' })
    async update(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
        @Body() dto: UpdateSprintDto,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.sprintsService.update(projectId, id, dto, user.sub);
    }

    @Post(':id/start')
    @HttpCode(HttpStatus.OK)
    @AuditLog({ entity: 'Sprint', action: 'UPDATE' })
    @ApiOperation({
        summary: 'Start a sprint (PLANNED → ACTIVE)',
        description:
            'Only one sprint can be ACTIVE per project at a time. Sets startDate to now if not already set.',
    })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Sprint CUID' })
    @ApiOkResponse({
        type: SprintEntity,
        description: 'Sprint started',
    })
    @ApiBadRequestResponse({
        description:
            'Sprint is not in PLANNED status or another sprint is already active',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Sprint or project not found' })
    async start(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.sprintsService.start(projectId, id, user.sub);
    }

    @Post(':id/complete')
    @HttpCode(HttpStatus.OK)
    @AuditLog({ entity: 'Sprint', action: 'UPDATE' })
    @ApiOperation({
        summary: 'Complete a sprint (ACTIVE → COMPLETED)',
        description:
            'Incomplete tasks (status != DONE) are moved back to the backlog. Sets endDate to now if not already set.',
    })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Sprint CUID' })
    @ApiOkResponse({
        type: SprintEntity,
        description: 'Sprint completed',
    })
    @ApiBadRequestResponse({
        description: 'Sprint is not in ACTIVE status',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Sprint not found' })
    async complete(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.sprintsService.complete(projectId, id, user.sub);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @AuditLog({ entity: 'Sprint', action: 'DELETE' })
    @ApiOperation({
        summary: 'Delete a sprint',
        description:
            'Cannot delete an active sprint. Tasks in the sprint are moved back to the backlog.',
    })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'id', description: 'Sprint CUID' })
    @ApiNoContentResponse({ description: 'Sprint deleted' })
    @ApiBadRequestResponse({ description: 'Cannot delete an active sprint' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Sprint not found' })
    async remove(
        @Param('projectId') projectId: string,
        @Param('id') id: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.sprintsService.remove(projectId, id, user.sub);
    }
}
