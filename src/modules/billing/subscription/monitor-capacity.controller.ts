import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
    AuditLog,
    CurrentUser,
    Roles,
    SkipMaintenance,
} from '../../../common/decorators';
import { OrgMemberGuard, RolesGuard } from '../../../common/guards';
import { MembershipRole } from '../../../generated/prisma/enums';
import type { JwtPayload } from '../../../common/interfaces/jwt-payload.interface';
import { BillingMonitorCapacityService } from './monitor-capacity.service';
import { SelectMonitorCapacityDto } from './dto/select-monitor-capacity.dto';

@ApiTags('Billing / Subscription')
@ApiBearerAuth('access-token')
@ApiParam({ name: 'orgId', description: 'Organization CUID' })
@ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
@ApiForbiddenResponse({ description: 'Organization administrator required' })
@ApiNotFoundResponse({ description: 'Organization not found' })
@UseGuards(OrgMemberGuard, RolesGuard)
@Roles(MembershipRole.ADMIN)
@Controller('organizations/:orgId/subscription/monitor-capacity')
export class MonitorCapacityController {
    constructor(private readonly capacity: BillingMonitorCapacityService) {}

    @Get()
    @SkipMaintenance()
    @ApiOperation({
        summary:
            'View monitor downgrade grace, retained slots and restrictions (organization admin)',
    })
    @ApiOkResponse({
        description:
            'Current plan limit, counts, cycle, deadlines and retained monitor IDs',
    })
    get(@Param('orgId') orgId: string, @CurrentUser() user: JwtPayload) {
        return this.capacity.get(orgId, user);
    }

    @Patch()
    @AuditLog({ entity: 'MonitorCapacityCycle' })
    @ApiOperation({
        summary:
            'Choose retained monitors without extending the downgrade deadline',
    })
    @ApiOkResponse({
        description: 'Updated retention selection and current restrictions',
    })
    @ApiBadRequestResponse({
        description: 'Stale cycle, excess choices or unavailable monitor IDs',
    })
    select(
        @Param('orgId') orgId: string,
        @CurrentUser() user: JwtPayload,
        @Body() dto: SelectMonitorCapacityDto,
    ) {
        return this.capacity.select(orgId, user, dto);
    }
}
