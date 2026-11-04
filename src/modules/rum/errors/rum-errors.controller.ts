import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
} from '@nestjs/swagger';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { CurrentPrincipal } from '../../../common/authorization/current-principal.decorator';
import { ProjectAccessGuard } from '../../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../../common/authorization/project-permission.decorator';
import { QueryRumErrorOccurrencesDto, QueryRumErrorsDto } from '../dto';
import {
    RumErrorGroupEntity,
    RumErrorGroupListEntity,
    RumErrorOccurrenceListEntity,
} from '../entities';
import { RumErrorsService } from './rum-errors.service';

@ApiTags('RUM Errors')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/apps/:appId/errors')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('rum.read', {
    resourceType: 'RUM_APP',
    idParam: 'appId',
})
export class RumErrorsController {
    constructor(private readonly errors: RumErrorsService) {}

    @Get()
    @ApiOperation({ summary: 'List aggregated errors for a RUM app' })
    @ApiOkResponse({ type: RumErrorGroupListEntity })
    findAll(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Query() query: QueryRumErrorsDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.errors.findAll(projectId, appId, query, principal);
    }

    @Get(':errorId')
    @ApiOperation({ summary: 'Get an aggregated RUM error' })
    @ApiParam({ name: 'errorId', description: 'RUM error group CUID' })
    @ApiOkResponse({ type: RumErrorGroupEntity })
    @ApiNotFoundResponse({ description: 'RUM error not found' })
    findOne(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Param('errorId') errorId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.errors.findOne(projectId, appId, errorId, principal);
    }

    @Get(':errorId/occurrences')
    @ApiOperation({ summary: 'List occurrences for an aggregated RUM error' })
    @ApiParam({ name: 'errorId', description: 'RUM error group CUID' })
    @ApiOkResponse({ type: RumErrorOccurrenceListEntity })
    @ApiNotFoundResponse({ description: 'RUM error not found' })
    findOccurrences(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Param('errorId') errorId: string,
        @Query() query: QueryRumErrorOccurrencesDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.errors.findOccurrences(
            projectId,
            appId,
            errorId,
            query,
            principal,
        );
    }
}
