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
import { ProjectAccessGuard } from '../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../common/authorization/project-permission.decorator';
import { CurrentPrincipal } from '../../common/authorization/current-principal.decorator';
import type { AccessPrincipal } from '../../common/authorization/access.types';
import { RuleBindingsService } from './rule-bindings.service';
import { BindRuleDto } from './dto';

// 挂在 monitor 所属 project 下，OrgMemberGuard 可通过 projectId 解析组织
@ApiTags('Rule Bindings')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/monitors/:monitorId/rule-bindings')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('rule.manage', {
    resourceType: 'MONITOR',
    idParam: 'monitorId',
})
export class RuleBindingsController {
    constructor(private readonly service: RuleBindingsService) {}

    @Post()
    @ApiOperation({ summary: 'Bind a rule group to a monitor' })
    bind(
        @Param('projectId') projectId: string,
        @Param('monitorId') monitorId: string,
        @Body() dto: BindRuleDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.service.bind({ monitorId, ...dto }, projectId, principal);
    }

    @Get()
    @ProjectPermission('monitor.read', {
        resourceType: 'MONITOR',
        idParam: 'monitorId',
    })
    @ApiOperation({ summary: 'List rule bindings of a monitor' })
    list(
        @Param('projectId') projectId: string,
        @Param('monitorId') monitorId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.service.listByMonitor(monitorId, projectId, principal);
    }

    @Delete(':ruleGroupId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Unbind a rule group from a monitor' })
    unbind(
        @Param('projectId') projectId: string,
        @Param('monitorId') monitorId: string,
        @Param('ruleGroupId') ruleGroupId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.service.unbind(
            monitorId,
            ruleGroupId,
            projectId,
            principal,
        );
    }
}
