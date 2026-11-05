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
import { QueryRumAppOverviewDto } from '../dto';
import { RumAppOverviewEntity } from './rum-app-overview.entity';
import { RumAppOverviewService } from './rum-app-overview.service';

@ApiTags('RUM Apps')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/apps/:appId/overview')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('rum.read', {
    resourceType: 'RUM_APP',
    idParam: 'appId',
})
export class RumAppOverviewController {
    constructor(private readonly overview: RumAppOverviewService) {}

    @Get()
    @ApiOperation({
        summary:
            'App overview: page views, unique visitors, clicks, request health, errors and the matching time series',
    })
    @ApiOkResponse({ type: RumAppOverviewEntity })
    @ApiNotFoundResponse({ description: 'RUM app not found' })
    overviewOfApp(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Query() query: QueryRumAppOverviewDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.overview.overview(projectId, appId, query, principal);
    }
}
