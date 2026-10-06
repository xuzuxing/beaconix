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
import {
    ApiBearerAuth,
    ApiBody,
    ApiCreatedResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AuditLog, Public } from '../../../common/decorators';
import {
    BindMonitorsDto,
    CreateProbeDto,
    QueryProbeExecutionsDto,
    QueryProbeResultsDto,
    UpdateProbeDto,
} from '../../probes/dto';
import { ProbeEntity } from '../../probes/entities';
import { ProbesService } from '../../probes/probes.service';
import { DeveloperAuthGuard } from '../auth/developer-auth.guard';
import { RequireScopes } from '../auth/require-scopes.decorator';

@ApiTags('Developer API - Probes')
@ApiBearerAuth('developer-api-key')
@Controller('developer/v1')
@SkipThrottle({ default: true })
export class DeveloperProbesController {
    constructor(private readonly probesService: ProbesService) {}

    @Get('organizations/:orgId/probes')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('probes:read')
    @ApiOperation({ summary: 'List probes in the organization' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiOkResponse({ type: [ProbeEntity] })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    async findAll(@Param('orgId') orgId: string) {
        return this.probesService.findAll(orgId);
    }

    @Post('organizations/:orgId/probes')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('probes:write')
    @AuditLog({ entity: 'Probe' })
    @ApiOperation({ summary: 'Create a probe' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiBody({ type: CreateProbeDto })
    @ApiCreatedResponse({ type: ProbeEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    async create(@Param('orgId') orgId: string, @Body() dto: CreateProbeDto) {
        return this.probesService.create(orgId, dto);
    }

    @Get('organizations/:orgId/probes/:id')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('probes:read')
    @ApiOperation({ summary: 'Get a probe' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Probe UUID' })
    @ApiOkResponse({ type: ProbeEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    @ApiNotFoundResponse({ description: 'Probe not found' })
    async findOne(@Param('orgId') orgId: string, @Param('id') id: string) {
        return this.probesService.findOne(orgId, id);
    }

    @Patch('organizations/:orgId/probes/:id')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('probes:write')
    @AuditLog({ entity: 'Probe' })
    @ApiOperation({ summary: 'Update a probe' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Probe UUID' })
    @ApiBody({ type: UpdateProbeDto })
    @ApiOkResponse({ type: ProbeEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    @ApiNotFoundResponse({ description: 'Probe not found' })
    async update(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @Body() dto: UpdateProbeDto,
    ) {
        return this.probesService.update(orgId, id, dto);
    }

    @Delete('organizations/:orgId/probes/:id')
    @HttpCode(HttpStatus.OK)
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('probes:write')
    @AuditLog({ entity: 'Probe', action: 'DELETE' })
    @ApiOperation({ summary: 'Delete a probe' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Probe UUID' })
    @ApiOkResponse({ description: 'Probe deleted' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    @ApiNotFoundResponse({ description: 'Probe not found' })
    async remove(@Param('orgId') orgId: string, @Param('id') id: string) {
        return this.probesService.remove(orgId, id);
    }

    @Post('organizations/:orgId/probes/:id/rotate-secret')
    @HttpCode(HttpStatus.OK)
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('probes:write')
    @AuditLog({ entity: 'Probe', action: 'UPDATE' })
    @ApiOperation({ summary: 'Rotate a probe secret' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Probe UUID' })
    @ApiOkResponse({ type: ProbeEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    @ApiNotFoundResponse({ description: 'Probe not found' })
    async rotateSecret(@Param('orgId') orgId: string, @Param('id') id: string) {
        return this.probesService.rotateSecret(orgId, id);
    }

    @Post('organizations/:orgId/probes/:id/monitors')
    @HttpCode(HttpStatus.OK)
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('probes:write')
    @AuditLog({ entity: 'Probe', action: 'ASSIGN' })
    @ApiOperation({ summary: 'Bind monitors to a probe' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Probe UUID' })
    @ApiBody({ type: BindMonitorsDto })
    @ApiOkResponse({ type: ProbeEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    @ApiNotFoundResponse({ description: 'Probe not found' })
    async bindMonitors(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @Body() dto: BindMonitorsDto,
    ) {
        return this.probesService.bindMonitors(orgId, id, dto);
    }

    @Delete('organizations/:orgId/probes/:id/monitors/:monitorId')
    @HttpCode(HttpStatus.OK)
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('probes:write')
    @AuditLog({ entity: 'Probe', action: 'UNASSIGN' })
    @ApiOperation({ summary: 'Unbind a monitor from a probe' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Probe UUID' })
    @ApiParam({ name: 'monitorId', description: 'Monitor UUID' })
    @ApiOkResponse({ type: ProbeEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    @ApiNotFoundResponse({ description: 'Probe or monitor not found' })
    async unbindMonitor(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @Param('monitorId') monitorId: string,
    ) {
        return this.probesService.unbindMonitor(orgId, id, monitorId);
    }

    @Get('organizations/:orgId/probes/:id/results')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('probes:read')
    @ApiOperation({ summary: 'List probe check results' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Probe UUID' })
    @ApiOkResponse({
        schema: {
            type: 'object',
            properties: {
                data: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/ProbeResultEntity' },
                },
                meta: { type: 'object' },
            },
        },
    })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    async listResults(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @Query() query: QueryProbeResultsDto,
    ) {
        return this.probesService.listResults(orgId, id, query);
    }

    @Get('organizations/:orgId/probes/:id/executions')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('probes:read')
    @ApiOperation({ summary: 'List probe executions' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Probe UUID' })
    @ApiOkResponse({
        schema: {
            type: 'object',
            properties: {
                data: {
                    type: 'array',
                    items: {
                        $ref: '#/components/schemas/ProbeExecutionEntity',
                    },
                },
                meta: { type: 'object' },
            },
        },
    })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    async listExecutions(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @Query() query: QueryProbeExecutionsDto,
    ) {
        return this.probesService.listExecutions(orgId, id, query);
    }
}
