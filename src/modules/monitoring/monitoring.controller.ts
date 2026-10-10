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
        description: 'Overview across every monitor in the organization',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    async getOrganizationOverview(@Param('orgId') orgId: string) {
        return this.monitoringService.getOrganizationOverview(orgId);
    }

    @Get('projects/:projectId/monitoring/overview')
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'Monitoring overview for a project' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiOkResponse({
        type: MonitoringOverviewEntity,
        description: 'Overview across the monitors of the project',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    async getProjectOverview(@Param('projectId') projectId: string) {
        return this.monitoringService.getProjectOverview(projectId);
    }
}
