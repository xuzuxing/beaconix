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
import { AuditLog } from '../../../common/decorators';
import { SuperAdminGuard } from '../../../common/guards';
import { ProbeEntity } from '../../probes/entities';
import { ProbeValidationService } from '../../probes/probe-validation.service';
import {
    CreateSystemProbeDto,
    ToggleSystemProbeDto,
    UpdateSystemProbeDto,
} from './dto';
import { SystemProbesService } from './system-probes.service';

@ApiTags('Admin / System Probes')
@ApiBearerAuth('access-token')
@UseGuards(SuperAdminGuard)
@Controller('admin/system-probes')
export class SystemProbesController {
    constructor(
        private readonly systemProbesService: SystemProbesService,
        private readonly probeValidationService: ProbeValidationService,
    ) {}

    @Post()
    @AuditLog({ entity: 'Probe' })
    @ApiOperation({ summary: 'Create a system probe' })
    @ApiBody({ type: CreateSystemProbeDto })
    @ApiCreatedResponse({
        type: ProbeEntity,
        description: 'System probe created',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    create(@Body() dto: CreateSystemProbeDto) {
        return this.systemProbesService.create(dto);
    }

    @Post(':id/validate')
    @HttpCode(HttpStatus.OK)
    @AuditLog({ entity: 'Probe', action: 'UPDATE' })
    @ApiOperation({
        summary: 'Create a validation challenge for a system probe',
    })
    @ApiParam({ name: 'id', description: 'Probe UUID' })
    @ApiOkResponse({
        description: '{ validationId, expiresAt, status }',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'System probe not found' })
    validate(@Param('id') id: string) {
        return this.probeValidationService.triggerForSystem(id);
    }

    @Post('rebalance')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Rebalance system probe assignments' })
    @ApiOkResponse({ description: 'System probe assignment map' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    rebalance() {
        return this.systemProbesService.rebalance();
    }

    @Get()
    @ApiOperation({ summary: 'List system probes' })
    @ApiOkResponse({ type: [ProbeEntity], description: 'System probe list' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    findAll() {
        return this.systemProbesService.findAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a system probe' })
    @ApiParam({ name: 'id', description: 'Probe UUID' })
    @ApiOkResponse({ type: ProbeEntity, description: 'System probe details' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'System probe not found' })
    findOne(@Param('id') id: string) {
        return this.systemProbesService.findOne(id);
    }

    @Patch(':id')
    @AuditLog({ entity: 'Probe' })
    @ApiOperation({ summary: 'Update a system probe' })
    @ApiParam({ name: 'id', description: 'Probe UUID' })
    @ApiBody({ type: UpdateSystemProbeDto })
    @ApiOkResponse({ type: ProbeEntity, description: 'System probe updated' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'System probe not found' })
    update(@Param('id') id: string, @Body() dto: UpdateSystemProbeDto) {
        return this.systemProbesService.update(id, dto);
    }

    @Patch(':id/toggle')
    @AuditLog({ entity: 'Probe', action: 'UPDATE' })
    @ApiOperation({ summary: 'Enable or disable a system probe' })
    @ApiParam({ name: 'id', description: 'Probe UUID' })
    @ApiBody({ type: ToggleSystemProbeDto })
    @ApiOkResponse({ type: ProbeEntity, description: 'System probe toggled' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'System probe not found' })
    toggle(@Param('id') id: string, @Body() dto: ToggleSystemProbeDto) {
        return this.systemProbesService.toggle(id, dto.enabled);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    @AuditLog({ entity: 'Probe', action: 'DELETE' })
    @ApiOperation({ summary: 'Delete a system probe' })
    @ApiParam({ name: 'id', description: 'Probe UUID' })
    @ApiOkResponse({ description: 'System probe deleted' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'System probe not found' })
    async remove(@Param('id') id: string) {
        await this.systemProbesService.remove(id);
        return { id, deleted: true };
    }
}
