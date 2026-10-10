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
import { Roles, AuditLog } from '../../common/decorators';
import { RolesGuard, OrgMemberGuard } from '../../common/guards';

@ApiTags('Monitor Checks')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/monitors')
export class CheckerController {
    constructor(private readonly checkerService: CheckerService) {}

    @Post(':monitorId/check')
    @HttpCode(HttpStatus.OK)
    @UseGuards(OrgMemberGuard, RolesGuard)
    @Roles('MEMBER')
    @AuditLog({ entity: 'Monitor', action: 'UPDATE', idParam: 'monitorId' })
    @ApiOperation({
        summary: 'Run a check for a monitor right now',
    })
    @ApiParam({ name: 'projectId', description: 'Project UUID' })
    @ApiParam({ name: 'monitorId', description: 'Monitor UUID' })
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
    ) {
        return this.checkerService.checkMonitorForProject(projectId, monitorId);
    }

    @Get(':monitorId/checks')
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'List the check history of a monitor' })
    @ApiParam({ name: 'projectId', description: 'Project UUID' })
    @ApiParam({ name: 'monitorId', description: 'Monitor UUID' })
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
    ) {
        return this.checkerService.listCheckLogs(projectId, monitorId, query);
    }
}
