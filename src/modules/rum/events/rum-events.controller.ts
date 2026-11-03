import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { CurrentPrincipal } from '../../../common/authorization/current-principal.decorator';
import { ProjectAccessGuard } from '../../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../../common/authorization/project-permission.decorator';
import { QueryRumEventsDto, QueryRumEventStatsDto } from '../dto';
import { RumEventsService } from './rum-events.service';

@ApiTags('RUM Events')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/apps/:appId/events')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('rum.read', {
    resourceType: 'RUM_APP',
    idParam: 'appId',
})
export class RumEventsController {
    constructor(private readonly events: RumEventsService) {}

    @Get()
    @ApiOperation({ summary: 'List RUM analytics events' })
    findAll(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Query() query: QueryRumEventsDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.events.findAll(projectId, appId, query, principal);
    }

    @Get('stats')
    @ApiOperation({ summary: 'Get RUM event totals, uniques and daily stats' })
    stats(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Query() query: QueryRumEventStatsDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.events.stats(projectId, appId, query, principal);
    }
}
