import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { CurrentPrincipal } from '../../../common/authorization/current-principal.decorator';
import { ProjectAccessGuard } from '../../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../../common/authorization/project-permission.decorator';
import {
    RumReleaseCompareEntity,
    RumReleaseListEntity,
} from './rum-releases.entity';
import { RumReleasesService } from './rum-releases.service';

@ApiTags('RUM Releases')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/apps/:appId/releases')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('app.manage', {
    resourceType: 'RUM_APP',
    idParam: 'appId',
})
export class RumReleasesController {
    constructor(private readonly releases: RumReleasesService) {}

    @Get()
    @ProjectPermission('rum.read', {
        resourceType: 'RUM_APP',
        idParam: 'appId',
    })
    @ApiOperation({
        summary:
            'List releases seen for a RUM app with error, event and replay volume',
    })
    @ApiOkResponse({ type: RumReleaseListEntity })
    @ApiNotFoundResponse({ description: 'RUM app not found' })
    findAll(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.releases.list(projectId, appId, principal);
    }

    @Get('compare')
    @ProjectPermission('rum.read', {
        resourceType: 'RUM_APP',
        idParam: 'appId',
    })
    @ApiOperation({
        summary:
            'Compare two releases by fingerprint: new, fixed and regressed error groups',
    })
    @ApiParam({ name: 'appId', description: 'RUM app CUID' })
    @ApiQuery({
        name: 'base',
        required: true,
        description: 'Baseline release; empty value means the unknown release',
    })
    @ApiQuery({
        name: 'target',
        required: true,
        description: 'Release under evaluation; empty value means unknown',
    })
    @ApiOkResponse({ type: RumReleaseCompareEntity })
    @ApiNotFoundResponse({ description: 'RUM app not found' })
    compare(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Query('base') base: string | undefined,
        @Query('target') target: string | undefined,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.releases.compare(projectId, appId, base, target, principal);
    }
}
