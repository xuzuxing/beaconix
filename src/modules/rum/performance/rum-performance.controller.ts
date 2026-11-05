import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { CurrentPrincipal } from '../../../common/authorization/current-principal.decorator';
import { ProjectAccessGuard } from '../../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../../common/authorization/project-permission.decorator';
import {
    QueryRumPerformanceDto,
    QueryRumPerformancePagesDto,
    QueryRumPerformanceResourcesDto,
} from '../dto';
import {
    RumPerformancePagesEntity,
    RumPerformanceResourcesEntity,
    RumPerformanceResponseEntity,
    RumPerformanceSummaryEntity,
} from './rum-performance.entity';
import { RumPerformanceService } from './rum-performance.service';

@ApiTags('RUM Performance')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/apps/:appId/performance')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('rum.read', {
    resourceType: 'RUM_APP',
    idParam: 'appId',
})
export class RumPerformanceController {
    constructor(private readonly performance: RumPerformanceService) {}

    @Get()
    @ApiOperation({
        summary:
            'Time series, current p75 and window-over-window change for performance metrics',
    })
    @ApiOkResponse({ type: RumPerformanceResponseEntity })
    @ApiNotFoundResponse({ description: 'RUM app not found' })
    series(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Query() query: QueryRumPerformanceDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.performance.series(projectId, appId, query, principal);
    }

    @Get('summary')
    @ApiOperation({
        summary: 'Rating distribution and p75 per performance metric',
    })
    @ApiOkResponse({ type: RumPerformanceSummaryEntity })
    @ApiNotFoundResponse({ description: 'RUM app not found' })
    summary(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Query() query: QueryRumPerformanceDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.performance.summary(projectId, appId, query, principal);
    }

    @Get('pages')
    @ApiOperation({ summary: 'Page-level p75 load time and error rate' })
    @ApiOkResponse({ type: RumPerformancePagesEntity })
    @ApiNotFoundResponse({ description: 'RUM app not found' })
    pages(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Query() query: QueryRumPerformancePagesDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.performance.pages(projectId, appId, query, principal);
    }

    @Get('resources')
    @ApiOperation({
        summary:
            'Slowest resources (or API requests) with p75 and failure rate',
    })
    @ApiOkResponse({ type: RumPerformanceResourcesEntity })
    @ApiNotFoundResponse({ description: 'RUM app not found' })
    resources(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Query() query: QueryRumPerformanceResourcesDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.performance.resources(projectId, appId, query, principal);
    }
}
