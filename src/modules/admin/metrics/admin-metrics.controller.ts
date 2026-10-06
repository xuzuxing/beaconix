import { Controller, Get, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiForbiddenResponse,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SuperAdminGuard } from '../../../common/guards';
import { AdminMetricsService } from './admin-metrics.service';
import {
    AdminMetricsOverviewEntity,
    AdminSchedulerHealthEntity,
    AdminTenantMetricEntity,
} from './entities';

@ApiTags('Admin / Metrics')
@ApiBearerAuth('access-token')
@UseGuards(SuperAdminGuard)
@Controller('admin/metrics')
export class AdminMetricsController {
    constructor(private readonly adminMetricsService: AdminMetricsService) {}

    @Get('scheduler')
    @ApiOperation({ summary: 'Monitor scheduler and queue health' })
    @ApiOkResponse({
        type: AdminSchedulerHealthEntity,
        description:
            'Queue backlog, registered job schedulers and the due backlog',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    async getSchedulerHealth() {
        return this.adminMetricsService.getSchedulerHealth();
    }

    @Get('overview')
    @ApiOperation({ summary: 'Platform-wide usage overview' })
    @ApiOkResponse({
        type: AdminMetricsOverviewEntity,
        description: 'Aggregated platform metrics',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    async getOverview() {
        return this.adminMetricsService.getOverview();
    }

    @Get('tenants')
    @ApiOperation({ summary: 'Usage metrics per tenant' })
    @ApiOkResponse({
        type: [AdminTenantMetricEntity],
        description: 'One metric row per tenant',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    async getTenants() {
        return this.adminMetricsService.getTenantMetrics();
    }
}
