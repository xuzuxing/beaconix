import {
    Controller,
    Get,
    Post,
    Param,
    Query,
    HttpCode,
    HttpStatus,
    UseGuards,
} from '@nestjs/common';
import {
    ApiTags,
    ApiBearerAuth,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiOkResponse,
    ApiUnauthorizedResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiBadRequestResponse,
} from '@nestjs/swagger';
import { CheckerService } from './checker.service';
import { QueryCheckLogsDto } from './dto';
import { CheckLogEntity } from './entities';
import { ProjectAccessGuard } from '../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../common/authorization/project-permission.decorator';
import { CurrentPrincipal } from '../../common/authorization/current-principal.decorator';
import type { AccessPrincipal } from '../../common/authorization/access.types';

@ApiTags('Monitor Checks')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/monitors')
@UseGuards(ProjectAccessGuard)
export class CheckerController {
    constructor(private readonly checkerService: CheckerService) {}

    @Post(':monitorId/check')
    @HttpCode(HttpStatus.OK)
    @ProjectPermission('monitor.check', {
        resourceType: 'MONITOR',
        idParam: 'monitorId',
    })
    @ApiOperation({
        summary: 'Run a check for a monitor right now',
    })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'monitorId', description: 'Monitor CUID' })
    @ApiOkResponse({ description: 'The check outcome and the derived status' })
    @ApiBadRequestResponse({ description: 'Monitor is paused' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({
        description:
            'Insufficient role (requires MEMBER) or monitor type/interval not allowed by plan',
    })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async check(
        @Param('projectId') projectId: string,
        @Param('monitorId') monitorId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.checkerService.checkMonitorForProject(
            projectId,
            monitorId,
            principal,
        );
    }

    @Get(':monitorId/checks')
    @ProjectPermission('monitor.read', {
        resourceType: 'MONITOR',
        idParam: 'monitorId',
    })
    @ApiOperation({ summary: 'List the check history of a monitor' })
    @ApiParam({ name: 'projectId', description: 'Project CUID' })
    @ApiParam({ name: 'monitorId', description: 'Monitor CUID' })
    @ApiQuery({ type: QueryCheckLogsDto })
    @ApiOkResponse({
        type: [CheckLogEntity],
        description: 'Paginated check history',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    @ApiNotFoundResponse({ description: 'Monitor not found' })
    async listChecks(
        @Param('projectId') projectId: string,
        @Param('monitorId') monitorId: string,
        @Query() query: QueryCheckLogsDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.checkerService.listCheckLogs(
            projectId,
            monitorId,
            query,
            principal,
        );
    }
}
