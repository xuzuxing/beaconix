import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiBody,
    ApiConflictResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { ProjectAccessGuard } from '../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../common/authorization/project-permission.decorator';
import { ReplaceProjectPermissionsDto } from './dto/project-permissions.dto';
import { ProjectPermissionsService } from './project-permissions.service';

@ApiTags('Project Permissions')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Invalid or inactive identity' })
@ApiForbiddenResponse({ description: 'Insufficient permission' })
@ApiNotFoundResponse({
    description: 'Organization, project or membership not found',
})
@Controller('organizations/:orgId')
export class OrganizationProjectPermissionsController {
    constructor(private readonly permissions: ProjectPermissionsService) {}

    @Get('my-permissions')
    @ApiOperation({ summary: 'Get current organization capabilities' })
    @ApiOkResponse({
        description:
            'Current membership incarnation, version and organization capabilities',
    })
    myPermissions(
        @Param('orgId') orgId: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.permissions.organizationPermissions(orgId, user.sub);
    }

    @Get('members/:userId/project-permissions')
    @ApiOperation({ summary: 'Get member project permissions' })
    @ApiOkResponse({
        description:
            'Assigned grants, effective roles and optimistic preconditions',
    })
    memberPermissions(
        @Param('orgId') orgId: string,
        @Param('userId') userId: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.permissions.findMemberPermissions(orgId, userId, user.sub);
    }

    @Put('members/:userId/project-permissions')
    @ApiOperation({ summary: 'Atomically replace explicit project grants' })
    @ApiBody({ type: ReplaceProjectPermissionsDto })
    @ApiOkResponse({
        description: 'Updated grants and incremented permission version',
    })
    @ApiBadRequestResponse({
        description: 'Invalid grants or administrator target',
    })
    @ApiConflictResponse({
        description: 'Membership incarnation or version changed',
    })
    replace(
        @Param('orgId') orgId: string,
        @Param('userId') userId: string,
        @CurrentUser() user: JwtPayload,
        @Body() dto: ReplaceProjectPermissionsDto,
    ) {
        return this.permissions.replace(orgId, userId, user.sub, dto);
    }
}

@ApiTags('Project Permissions')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Invalid or inactive identity' })
@ApiForbiddenResponse({ description: 'Insufficient permission' })
@ApiNotFoundResponse({ description: 'Project not found or not accessible' })
@UseGuards(ProjectAccessGuard)
@ProjectPermission('project.read', {
    resourceType: 'PROJECT',
    idParam: 'projectId',
})
@Controller('projects/:projectId')
export class ProjectPermissionsController {
    constructor(private readonly permissions: ProjectPermissionsService) {}

    @Get('my-permissions')
    @ApiOperation({ summary: 'Get current project role and capabilities' })
    @ApiOkResponse({
        description: 'Assigned and effective role with action capabilities',
    })
    myPermissions(
        @Param('projectId') projectId: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.permissions.projectPermissions(projectId, user.sub);
    }

    @Get('members')
    @ApiOperation({ summary: 'List current project collaborators' })
    @ApiOkResponse({
        description: 'Minimal collaborator identities, no emails',
    })
    members(
        @Param('projectId') projectId: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.permissions.projectMembers(projectId, user.sub);
    }

    @Get('probe-options')
    @ApiOperation({
        summary: 'List project probe options without configuration',
    })
    @ApiOkResponse({ description: 'Probe IDs, names and online status only' })
    probes(
        @Param('projectId') projectId: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.permissions.probeOptions(projectId, user.sub);
    }

    @Get('notification-channel-options')
    @ApiOperation({
        summary: 'List project notification channel options without secrets',
    })
    @ApiOkResponse({ description: 'Channel IDs, names and types only' })
    channels(
        @Param('projectId') projectId: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.permissions.notificationChannelOptions(projectId, user.sub);
    }
}
