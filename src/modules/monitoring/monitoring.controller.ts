import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiForbiddenResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { OrgMemberGuard } from '../../common/guards';
import { MonitoringOverviewEntity } from './entities';
import { MonitoringService } from './monitoring.service';
import { CurrentPrincipal } from '../../common/authorization/current-principal.decorator';
import type { AccessPrincipal } from '../../common/authorization/access.types';
import { ProjectAccessGuard } from '../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../common/authorization/project-permission.decorator';

@ApiTags('Monitoring')
@ApiBearerAuth('access-token')
@Controller()
export class MonitoringController {
    constructor(private readonly monitoringService: MonitoringService) {}

    @Get('organizations/:orgId/monitoring/overview')
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'Monitoring overview for an organization' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiOkResponse({
        type: MonitoringOverviewEntity,
        description:
            'Overview across the caller-visible projects in the organization',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    async getOrganizationOverview(
        @Param('orgId') orgId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.monitoringService.getOrganizationOverview(orgId, principal);
    }

    @Get('projects/:projectId/monitoring/overview')
    @UseGuards(ProjectAccessGuard)
    @ProjectPermission('monitoring.read', {
        resourceType: 'PROJECT',
        idParam: 'projectId',
    })
    @ApiOperation({ summary: 'Monitoring overview for a project' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiOkResponse({
        type: MonitoringOverviewEntity,
        description: 'Overview across the monitors of the project',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    async getProjectOverview(
        @Param('projectId') projectId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.monitoringService.getProjectOverview(projectId, principal);
    }
}
