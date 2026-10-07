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
import { AuditLog, Roles } from '../../common/decorators';
import { OrgMemberGuard, RolesGuard } from '../../common/guards';
import { RuleGroupsService } from './rule-groups.service';
import { CreateRuleGroupDto, UpdateRuleGroupDto } from './dto';

@ApiTags('Rule Groups')
@ApiBearerAuth('access-token')
@Controller('organizations/:orgId/rule-groups')
export class RuleGroupsController {
    constructor(private readonly service: RuleGroupsService) {}

    @Post()
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'RuleGroup' })
    @ApiOperation({ summary: 'Create a rule group (nested rule tree)' })
    create(@Param('orgId') orgId: string, @Body() dto: CreateRuleGroupDto) {
        return this.service.create({ organizationId: orgId, ...dto });
    }

    @Get()
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'List rule groups in the organization' })
    list(@Param('orgId') orgId: string) {
        return this.service.listByOrganization(orgId);
    }

    @Get(':id')
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'Get a rule group' })
    findOne(@Param('orgId') orgId: string, @Param('id') id: string) {
        return this.service.findOne(orgId, id);
    }

    @Patch(':id')
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'RuleGroup' })
    @ApiOperation({ summary: 'Update a rule group' })
    update(@Param('id') id: string, @Body() dto: UpdateRuleGroupDto) {
        return this.service.update(id, dto);
    }

    @Delete(':id')
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'RuleGroup', action: 'DELETE' })
    @ApiOperation({ summary: 'Soft delete a rule group' })
    remove(@Param('id') id: string) {
        return this.service.softDelete(id);
    }
}
