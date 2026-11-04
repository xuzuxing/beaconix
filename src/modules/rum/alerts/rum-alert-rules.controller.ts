import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { CurrentPrincipal } from '../../../common/authorization/current-principal.decorator';
import { ProjectAccessGuard } from '../../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../../common/authorization/project-permission.decorator';
import {
    CreateRumAlertRuleDto,
    QueryRumAlertIncidentsDto,
    UpdateRumAlertRuleDto,
} from '../dto';
import { RumAlertRulesService } from './rum-alert-rules.service';

@ApiTags('RUM Alerts')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/apps/:appId/alerts')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('app.manage', {
    resourceType: 'RUM_APP',
    idParam: 'appId',
})
export class RumAlertRulesController {
    constructor(private readonly alerts: RumAlertRulesService) {}

    @Get()
    @ProjectPermission('rum.read', {
        resourceType: 'RUM_APP',
        idParam: 'appId',
    })
    @ApiOperation({ summary: 'List RUM alert rules' })
    findAll(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.alerts.findAll(projectId, appId, principal);
    }

    @Get('channels')
    @ApiOperation({
        summary: 'List notification channels available to this RUM app',
    })
    channels(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.alerts.channels(projectId, appId, principal);
    }

    @Post()
    @ApiOperation({ summary: 'Create a RUM count threshold alert' })
    create(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Body() dto: CreateRumAlertRuleDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.alerts.create(projectId, appId, dto, principal);
    }

    @Patch(':ruleId')
    @ApiOperation({ summary: 'Update a RUM alert rule' })
    update(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Param('ruleId') ruleId: string,
        @Body() dto: UpdateRumAlertRuleDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.alerts.update(projectId, appId, ruleId, dto, principal);
    }

    @Delete(':ruleId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Delete a RUM alert rule' })
    remove(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Param('ruleId') ruleId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.alerts.remove(projectId, appId, ruleId, principal);
    }

    @Get('incidents')
    @ProjectPermission('rum.read', {
        resourceType: 'RUM_APP',
        idParam: 'appId',
    })
    @ApiOperation({ summary: 'List RUM alert incidents' })
    incidents(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Query() query: QueryRumAlertIncidentsDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.alerts.incidents(projectId, appId, query, principal);
    }
}
