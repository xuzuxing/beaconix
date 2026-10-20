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
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiBody,
    ApiConflictResponse,
    ApiCreatedResponse,
    ApiForbiddenResponse,
    ApiNoContentResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuditLog } from '../../../common/decorators';
import { SuperAdminGuard } from '../../../common/guards';
import { PlanEntity } from '../../billing/plan/entities';
import { AdminPlansService } from './admin-plans.service';
import { CreatePlanDto, UpdatePlanDto } from './dto';

@ApiTags('Admin / Plans')
@ApiBearerAuth('access-token')
@UseGuards(SuperAdminGuard)
@Controller('admin/plans')
export class AdminPlansController {
    constructor(private readonly adminPlansService: AdminPlansService) {}

    @Get()
    @ApiOperation({
        summary: 'List every billing plan',
        description:
            'Includes disabled plans, ordered by sortOrder then code. This is the admin catalog — the public `GET /api/plans` only returns enabled plans.',
    })
    @ApiOkResponse({ type: [PlanEntity], description: 'Plan catalog' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    async findAll() {
        return this.adminPlansService.findAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get any billing plan by ID' })
    @ApiParam({ name: 'id', description: 'Plan CUID' })
    @ApiOkResponse({ type: PlanEntity, description: 'Plan details' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Plan not found' })
    async findOne(@Param('id') id: string) {
        return this.adminPlansService.findOne(id);
    }

    @Post()
    @AuditLog({ entity: 'Plan' })
    @ApiOperation({
        summary: 'Create a billing plan',
        description:
            '`code` is trimmed and upper-cased before validation and can never be changed afterwards. A duplicate code is a 409. Quota limits apply immediately to every tenant on the plan: 0 means the resource cannot be used, and an empty `allowedMonitorTypes` blocks every monitor protocol.',
    })
    @ApiBody({ type: CreatePlanDto })
    @ApiCreatedResponse({ type: PlanEntity, description: 'Plan created' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiConflictResponse({ description: 'Plan code already exists' })
    async create(@Body() dto: CreatePlanDto) {
        return this.adminPlansService.create(dto);
    }

    @Patch(':id')
    @AuditLog({ entity: 'Plan' })
    @ApiOperation({
        summary: 'Update or enable/disable a billing plan',
        description:
            'Partial update: omitted fields keep their value, `description: null` clears it. `code` is immutable and may only be sent back unchanged. Also the enable/disable switch ({ "enabled": false }); disabled plans disappear from the public catalog and can no longer be ordered. Quota changes apply immediately to existing subscriptions.',
    })
    @ApiParam({ name: 'id', description: 'Plan CUID' })
    @ApiBody({ type: UpdatePlanDto })
    @ApiOkResponse({ type: PlanEntity, description: 'Updated plan' })
    @ApiBadRequestResponse({
        description: 'Validation failed, or `plan code is immutable`',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Plan not found' })
    @ApiConflictResponse({ description: 'Plan code already exists' })
    async update(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
        return this.adminPlansService.update(id, dto);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @AuditLog({ entity: 'Plan' })
    @ApiOperation({
        summary: 'Delete an unreferenced billing plan',
        description:
            'Plans referenced by orders or subscriptions must be disabled instead. The FREE fallback plan can never be deleted.',
    })
    @ApiParam({ name: 'id', description: 'Plan CUID' })
    @ApiNoContentResponse({ description: 'Plan deleted' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Plan not found' })
    @ApiConflictResponse({
        description: 'Plan is referenced by orders/subscriptions, or is FREE',
    })
    async remove(@Param('id') id: string) {
        await this.adminPlansService.remove(id);
    }
}
