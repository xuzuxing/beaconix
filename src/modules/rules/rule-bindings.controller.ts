import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators';
import { OrgMemberGuard, RolesGuard } from '../../common/guards';
import { RuleBindingsService } from './rule-bindings.service';
import { BindRuleDto } from './dto';

// 挂在 monitor 所属 project 下，OrgMemberGuard 可通过 projectId 解析组织
@ApiTags('Rule Bindings')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/monitors/:monitorId/rule-bindings')
export class RuleBindingsController {
    constructor(private readonly service: RuleBindingsService) {}

    @Post()
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @ApiOperation({ summary: 'Bind a rule group to a monitor' })
    bind(@Param('monitorId') monitorId: string, @Body() dto: BindRuleDto) {
        return this.service.bind({ monitorId, ...dto });
    }

    @Get()
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'List rule bindings of a monitor' })
    list(@Param('monitorId') monitorId: string) {
        return this.service.listByMonitor(monitorId);
    }

    @Delete(':ruleGroupId')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @ApiOperation({ summary: 'Unbind a rule group from a monitor' })
    unbind(
        @Param('monitorId') monitorId: string,
        @Param('ruleGroupId') ruleGroupId: string,
    ) {
        return this.service.unbind(monitorId, ruleGroupId);
    }
}
