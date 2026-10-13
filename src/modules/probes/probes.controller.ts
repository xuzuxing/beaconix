import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Body,
    Param,
    Query,
    HttpCode,
    HttpStatus,
    UseGuards,
} from '@nestjs/common';
import {
    ApiTags,
    ApiBearerAuth,
    ApiOperation,
    ApiParam,
    ApiBody,
    ApiQuery,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiBadRequestResponse,
    ApiUnauthorizedResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
} from '@nestjs/swagger';
import { ProbesService } from './probes.service';
import { ProbeValidationService } from './probe-validation.service';
import {
    BindMonitorsDto,
    CreateProbeDto,
    QueryProbeExecutionsDto,
    QueryProbeResultsDto,
    UpdateProbeDto,
} from './dto';
import { ProbeEntity } from './entities';
import { Roles, AuditLog, CurrentUser } from '../../common/decorators';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { RolesGuard, OrgMemberGuard } from '../../common/guards';

@ApiTags('Probes')
@ApiBearerAuth('access-token')
@Controller('organizations/:orgId/probes')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class ProbesController {
    constructor(
        private readonly probesService: ProbesService,
        private readonly probeValidationService: ProbeValidationService,
    ) {}

    @Get()
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'List the probes of the organization' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiOkResponse({ type: [ProbeEntity], description: 'List of probes' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    async findAll(@Param('orgId') orgId: string) {
        return this.probesService.findAll(orgId);
    }

    @Post()
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'Probe' })
    @ApiOperation({
        summary: 'Register a probe (the response carries its secret)',
    })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiBody({ type: CreateProbeDto })
    @ApiCreatedResponse({ type: ProbeEntity, description: 'Probe registered' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    async create(
        @Param('orgId') orgId: string,
        @Body() dto: CreateProbeDto,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.probesService.create(orgId, dto, user.sub);
    }

    @Get(':id')
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'Get a probe by ID' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiParam({ name: 'id', description: 'Probe CUID' })
    @ApiOkResponse({ type: ProbeEntity, description: 'Probe details' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    @ApiNotFoundResponse({ description: 'Probe not found' })
    async findOne(@Param('orgId') orgId: string, @Param('id') id: string) {
        return this.probesService.findOne(orgId, id);
    }

    @Patch(':id')
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'Probe' })
    @ApiOperation({ summary: 'Update a probe' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiParam({ name: 'id', description: 'Probe CUID' })
    @ApiBody({ type: UpdateProbeDto })
    @ApiOkResponse({ type: ProbeEntity, description: 'Probe updated' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Probe not found' })
    async update(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @Body() dto: UpdateProbeDto,
    ) {
        return this.probesService.update(orgId, id, dto);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'Probe', action: 'DELETE' })
    @ApiOperation({ summary: 'Delete a probe and its stored results' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiParam({ name: 'id', description: 'Probe CUID' })
    @ApiOkResponse({ description: 'Probe deleted' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Probe not found' })
    async remove(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @CurrentUser() user: JwtPayload,
    ) {
        await this.probesService.remove(orgId, id, user.sub);
        return { id, deleted: true };
    }

    @Post(':id/rotate-secret')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'Probe', action: 'UPDATE' })
    @ApiOperation({ summary: 'Rotate the shared secret of a probe' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiParam({ name: 'id', description: 'Probe CUID' })
    @ApiOkResponse({ type: ProbeEntity, description: 'Secret rotated' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Probe not found' })
    async rotateSecret(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.probesService.rotateSecret(orgId, id, user.sub);
    }

    @Post(':id/validate')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'Probe', action: 'UPDATE' })
    @ApiOperation({
        summary: 'Create a validation challenge for a probe',
    })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiParam({ name: 'id', description: 'Probe CUID' })
    @ApiOkResponse({
        description: '{ validationId, expiresAt, status }',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Probe not found' })
    async validate(@Param('orgId') orgId: string, @Param('id') id: string) {
        return this.probeValidationService.triggerForTenant(orgId, id);
    }

    @Post(':id/monitors')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'Probe', action: 'ASSIGN' })
    @ApiOperation({ summary: 'Attach monitors to a probe' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiParam({ name: 'id', description: 'Probe CUID' })
    @ApiBody({ type: BindMonitorsDto })
    @ApiOkResponse({ type: ProbeEntity, description: 'Monitors attached' })
    @ApiBadRequestResponse({
        description:
            'Validation failed, or a monitor is not in the organization',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Probe not found' })
    async bindMonitors(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @Body() dto: BindMonitorsDto,
    ) {
        return this.probesService.bindMonitors(orgId, id, dto);
    }

    @Delete(':id/monitors/:monitorId')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'Probe', action: 'UNASSIGN' })
    @ApiOperation({ summary: 'Detach a monitor from a probe' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiParam({ name: 'id', description: 'Probe CUID' })
    @ApiParam({ name: 'monitorId', description: 'Monitor CUID' })
    @ApiOkResponse({ type: ProbeEntity, description: 'Monitor detached' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({
        description: 'Probe not found, or the monitor is not attached',
    })
    async unbindMonitor(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @Param('monitorId') monitorId: string,
    ) {
        return this.probesService.unbindMonitor(orgId, id, monitorId);
    }

    @Get(':id/results')
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'List the raw results reported by a probe' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiParam({ name: 'id', description: 'Probe CUID' })
    @ApiQuery({ type: QueryProbeResultsDto })
    @ApiOkResponse({ description: 'Paginated probe results' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    @ApiNotFoundResponse({ description: 'Probe not found' })
    async listResults(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @Query() query: QueryProbeResultsDto,
    ) {
        return this.probesService.listResults(orgId, id, query);
    }

    @Get(':id/executions')
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'List execution audit records for a probe' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiParam({ name: 'id', description: 'Probe CUID' })
    @ApiQuery({ type: QueryProbeExecutionsDto })
    @ApiOkResponse({ description: 'Paginated probe executions' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    @ApiNotFoundResponse({ description: 'Probe not found' })
    async listExecutions(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @Query() query: QueryProbeExecutionsDto,
    ) {
        return this.probesService.listExecutions(orgId, id, query);
    }
}
