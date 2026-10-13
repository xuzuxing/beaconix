import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ProjectAccessGuard } from '../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../common/authorization/project-permission.decorator';
import { CurrentPrincipal } from '../../common/authorization/current-principal.decorator';
import type { AccessPrincipal } from '../../common/authorization/access.types';
import { QueryMonitorInsightsDto } from './dto/query-monitor-insights.dto';
import { MonitorInsightsEntity } from './entities/monitor-insights.entity';
import { MonitorInsightsService } from './monitor-insights.service';

@ApiTags('Monitoring')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/monitors/:monitorId/insights')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('monitoring.read', {
    resourceType: 'MONITOR',
    idParam: 'monitorId',
})
export class MonitorInsightsController {
    constructor(private readonly insights: MonitorInsightsService) {}

    @Get()
    @ApiOperation({
        summary: 'Monitor-specific metrics, recent checks and alert events',
    })
    @ApiParam({ name: 'projectId' })
    @ApiParam({ name: 'monitorId' })
    @ApiOkResponse({ type: MonitorInsightsEntity })
    @ApiBadRequestResponse({ description: 'Invalid range or time zone' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not an organization member' })
    @ApiNotFoundResponse({
        description: 'Monitor, project or organization not found',
    })
    get(
        @Param('projectId') projectId: string,
        @Param('monitorId') monitorId: string,
        @Query() query: QueryMonitorInsightsDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.insights.get(projectId, monitorId, query, principal);
    }
}
