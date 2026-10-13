import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiForbiddenResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../../common/decorators';
import { MonitoringService } from '../../monitoring/monitoring.service';
import { MonitoringOverviewEntity } from '../../monitoring/entities';
import { DeveloperAuthGuard } from '../auth/developer-auth.guard';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { CurrentPrincipal } from '../../../common/authorization/current-principal.decorator';
import type { AccessPrincipal } from '../../../common/authorization/access.types';

@ApiTags('Developer API - Monitoring')
@ApiBearerAuth('developer-api-key')
@Controller('developer/v1')
@SkipThrottle({ default: true })
export class DeveloperOverviewController {
    constructor(private readonly monitoringService: MonitoringService) {}

    @Get('organizations/:orgId/overview')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('monitoring:read')
    @ApiOperation({ summary: 'Monitoring overview for the organization' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiOkResponse({ type: MonitoringOverviewEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    async getOverview(
        @Param('orgId') orgId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.monitoringService.getOrganizationOverview(orgId, principal);
    }
}
