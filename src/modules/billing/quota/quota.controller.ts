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
import { SkipMaintenance } from '../../../common/decorators';
import { OrgMemberGuard } from '../../../common/guards';
import { QuotaService } from '../../../shared/quota/quota.service';

@ApiTags('Billing / Quota')
@ApiBearerAuth('access-token')
@Controller('organizations/:orgId/quota')
export class QuotaController {
    constructor(private readonly quotaService: QuotaService) {}

    @Get()
    @SkipMaintenance()
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'Current plan usage summary' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiOkResponse({
        description:
            'Effective plan, per-resource usage, feature switches and min interval',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    async getUsageSummary(@Param('orgId') orgId: string) {
        return this.quotaService.getUsageSummary(orgId);
    }
}
