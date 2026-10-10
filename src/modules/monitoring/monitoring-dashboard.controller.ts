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
import { OrgMemberGuard } from '../../common/guards';
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
@UseGuards(OrgMemberGuard)
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
    ) {
        return this.dashboard.dashboard(projectId, query);
    }

    @Get('availability')
    @SkipTransform()
    @ApiOperation({ summary: 'Availability by local date and hour' })
    @ApiOkResponse({ type: MonitoringAvailabilityEntity })
    getAvailability(
        @Param('projectId') projectId: string,
        @Query() query: QueryMonitoringAvailabilityDto,
    ) {
        return this.dashboard.availability(projectId, query);
    }

    @Get('status-codes')
    @SkipTransform()
    @ApiOperation({ summary: 'Observed HTTP status codes in UTC hour buckets' })
    @ApiOkResponse({ type: MonitoringStatusCodesEntity })
    getStatusCodes(
        @Param('projectId') projectId: string,
        @Query() query: QueryMonitoringStatusCodesDto,
    ) {
        return this.dashboard.statusCodes(projectId, query);
    }
}
