import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { CurrentPrincipal } from '../../../common/authorization/current-principal.decorator';
import { ProjectAccessGuard } from '../../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../../common/authorization/project-permission.decorator';
import {
    QueryProjectRumErrorsDto,
    QueryProjectRumEventsDto,
} from './query-project-rum.dto';
import { ProjectRumService } from './project-rum.service';
import {
    ProjectRumOverviewEntity,
    ProjectRumErrorPageEntity,
    ProjectRumEventPageEntity,
} from './project-rum.entity';

@ApiTags('RUM Project')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/rum')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('rum.read', {
    resourceType: 'PROJECT',
    idParam: 'projectId',
})
export class ProjectRumController {
    constructor(private readonly rum: ProjectRumService) {}

    @ApiOkResponse({ type: ProjectRumOverviewEntity })
    @Get('overview')
    @ApiOperation({ summary: 'Get RUM overview across the current project' })
    overview(
        @Param('projectId') projectId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.rum.overview(projectId, principal);
    }

    @ApiOkResponse({ type: ProjectRumErrorPageEntity })
    @Get('errors')
    @ApiOperation({
        summary: 'List aggregated errors across the current project',
    })
    errors(
        @Param('projectId') projectId: string,
        @Query() query: QueryProjectRumErrorsDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.rum.errors(projectId, query, principal);
    }

    @ApiOkResponse({ type: ProjectRumEventPageEntity })
    @Get('events')
    @ApiOperation({ summary: 'List events across the current project' })
    events(
        @Param('projectId') projectId: string,
        @Query() query: QueryProjectRumEventsDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.rum.events(projectId, query, principal);
    }
}
