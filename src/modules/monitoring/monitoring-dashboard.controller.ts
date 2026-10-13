import {
    Controller,
    Get,
    Param,
    Query,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiResponse,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ProjectAccessGuard } from '../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../common/authorization/project-permission.decorator';
import { CurrentPrincipal } from '../../common/authorization/current-principal.decorator';
import type { AccessPrincipal } from '../../common/authorization/access.types';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { MonitoringDashboardService } from './monitoring-dashboard.service';
import { MonitoringEtagInterceptor } from './monitoring-etag.interceptor';
import {
    QueryMonitoringAvailabilityDto,
    QueryMonitoringDashboardDto,
    QueryMonitoringStatusCodesDto,
} from './dto/query-monitoring.dto';
import {
    MonitoringAvailabilityEntity,
    MonitoringDashboardEntity,
    MonitoringStatusCodesEntity,
} from './entities/monitoring-dashboard.entity';

@ApiTags('Monitoring')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/monitoring')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('monitoring.read', {
    resourceType: 'PROJECT',
    idParam: 'projectId',
})
@UseInterceptors(MonitoringEtagInterceptor)
@ApiBadRequestResponse({ description: 'Invalid query parameters or time zone' })
@ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
@ApiForbiddenResponse({ description: 'Not an organization member' })
@ApiNotFoundResponse({ description: 'Project or organization not found' })
@ApiResponse({
    status: 304,
    description: 'Unchanged snapshot; no response body',
})
export class MonitoringDashboardController {
    constructor(private readonly dashboard: MonitoringDashboardService) {}

    @Get('dashboard')
    @SkipTransform()
    @ApiOperation({ summary: 'Complete project monitoring dashboard' })
    @ApiOkResponse({ type: MonitoringDashboardEntity })
    getDashboard(
        @Param('projectId') projectId: string,
        @Query() query: QueryMonitoringDashboardDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.dashboard.dashboard(projectId, query, principal);
    }

    @Get('availability')
    @SkipTransform()
    @ApiOperation({ summary: 'Availability by local date and hour' })
    @ApiOkResponse({ type: MonitoringAvailabilityEntity })
    getAvailability(
        @Param('projectId') projectId: string,
        @Query() query: QueryMonitoringAvailabilityDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.dashboard.availability(projectId, query, principal);
    }

    @Get('status-codes')
    @SkipTransform()
    @ApiOperation({ summary: 'Observed HTTP status codes in UTC hour buckets' })
    @ApiOkResponse({ type: MonitoringStatusCodesEntity })
    getStatusCodes(
        @Param('projectId') projectId: string,
        @Query() query: QueryMonitoringStatusCodesDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.dashboard.statusCodes(projectId, query, principal);
    }
}
