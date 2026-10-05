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
import { OrgMemberGuard } from '../../../common/guards';
import { SubscriptionStackEntity } from './entities';
import { SubscriptionService } from './subscription.service';

@ApiTags('Billing / Subscription')
@ApiBearerAuth('access-token')
@Controller('organizations/:orgId/subscription')
export class SubscriptionController {
    constructor(private readonly subscriptionService: SubscriptionService) {}

    @Get()
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'Get the subscription stack of an organization' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiOkResponse({
        type: SubscriptionStackEntity,
        description: 'Effective plan plus the active subscription stack',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    async getStack(@Param('orgId') orgId: string) {
        return this.subscriptionService.getStack(orgId);
    }
}
