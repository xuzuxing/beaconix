import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { CurrentPrincipal } from '../../../common/authorization/current-principal.decorator';
import { ProjectAccessGuard } from '../../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../../common/authorization/project-permission.decorator';
import { QueryRumReplayChunksDto, QueryRumReplaysDto } from '../dto';
import { RumReplaysService } from './rum-replays.service';

@ApiTags('RUM Session Replays')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/apps/:appId/replays')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('rum.read', {
    resourceType: 'RUM_APP',
    idParam: 'appId',
})
export class RumReplaysController {
    constructor(private readonly replays: RumReplaysService) {}

    @Get()
    @ApiOperation({ summary: 'List RUM replay sessions' })
    findAll(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Query() query: QueryRumReplaysDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.replays.findAll(projectId, appId, query, principal);
    }

    @Get(':replayId')
    @ApiOperation({ summary: 'Get RUM replay session metadata' })
    findOne(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Param('replayId') replayId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.replays.findOne(projectId, appId, replayId, principal);
    }

    @Get(':replayId/chunks')
    @ApiOperation({ summary: 'Read ordered RUM replay event chunks' })
    chunks(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Param('replayId') replayId: string,
        @Query() query: QueryRumReplayChunksDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.replays.chunks(
            projectId,
            appId,
            replayId,
            query,
            principal,
        );
    }
}
