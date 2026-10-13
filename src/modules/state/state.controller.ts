import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
    ApiTags,
    ApiBearerAuth,
    ApiOperation,
    ApiParam,
    ApiOkResponse,
    ApiUnauthorizedResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
} from '@nestjs/swagger';
import { StateService } from './state.service';
import { MonitorStateEntity } from './entities';
import { ProjectAccessGuard } from '../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../common/authorization/project-permission.decorator';
import { CurrentPrincipal } from '../../common/authorization/current-principal.decorator';
import type { AccessPrincipal } from '../../common/authorization/access.types';

@ApiTags('Monitor State')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/monitors/:monitorId/state')
export class StateController {
    constructor(private readonly stateService: StateService) {}

    @Get()
    @UseGuards(ProjectAccessGuard)
    @ProjectPermission('monitor.read', {
        resourceType: 'MONITOR',
        idParam: 'monitorId',
    })
    @ApiOperation({
        summary: 'Get the current state of a monitor (with a 24h summary)',
    })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'monitorId', description: 'Monitor CUID' })
    @ApiOkResponse({
        type: MonitorStateEntity,
        description: 'Monitor state',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async getState(
        @Param('projectId') projectId: string,
        @Param('monitorId') monitorId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.stateService.getSummary(projectId, monitorId, principal);
    }
}
