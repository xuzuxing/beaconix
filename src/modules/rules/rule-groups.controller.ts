import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditLog } from '../../common/decorators';
import { OrgMemberGuard } from '../../common/guards';
import { CurrentPrincipal } from '../../common/authorization/current-principal.decorator';
import type { AccessPrincipal } from '../../common/authorization/access.types';
import { RuleGroupsService } from './rule-groups.service';
import { CreateRuleGroupDto, UpdateRuleGroupDto } from './dto';

@ApiTags('Rule Groups')
@ApiBearerAuth('access-token')
@Controller('organizations/:orgId/rule-groups')
@UseGuards(OrgMemberGuard)
export class RuleGroupsController {
    constructor(private readonly service: RuleGroupsService) {}

    @Post()
    @AuditLog({ entity: 'RuleGroup' })
    @ApiOperation({ summary: 'Create a rule group (nested rule tree)' })
    create(
        @Param('orgId') orgId: string,
        @Body() dto: CreateRuleGroupDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.service.create(
            { organizationId: orgId, ...dto },
            principal,
        );
    }

    @Get()
    @ApiOperation({ summary: 'List rule groups in the organization' })
    list(
        @Param('orgId') orgId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.service.listByOrganization(orgId, principal);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a rule group' })
    findOne(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.service.findOne(orgId, id, principal);
    }

    @Patch(':id')
    @AuditLog({ entity: 'RuleGroup' })
    @ApiOperation({ summary: 'Update a rule group' })
    update(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @Body() dto: UpdateRuleGroupDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.service.update(id, dto, orgId, principal);
    }

    @Delete(':id')
    @AuditLog({ entity: 'RuleGroup', action: 'DELETE' })
    @ApiOperation({ summary: 'Soft delete a rule group' })
    remove(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.service.softDelete(id, orgId, principal);
    }
}
