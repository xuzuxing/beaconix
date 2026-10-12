import {
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiExtraModels,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
    getSchemaPath,
} from '@nestjs/swagger';
import { SuperAdminGuard } from '../../../common/guards';
import { QueryAdminOrdersDto } from './dto';
import { AdminOrderEntity } from './entities';
import { AdminOrdersService } from './admin-orders.service';

@ApiTags('Admin / Orders')
@ApiBearerAuth('access-token')
@UseGuards(SuperAdminGuard)
@ApiExtraModels(AdminOrderEntity)
@Controller('admin/orders')
export class AdminOrdersController {
    constructor(private readonly adminOrdersService: AdminOrdersService) {}

    @Get()
    @ApiOperation({
        summary: 'List orders across every tenant',
        description:
            'Cross-tenant order query for SUPER_ADMIN. All filters are opt-in.',
    })
    @ApiOkResponse({
        description: 'Paginated orders',
        schema: {
            properties: {
                items: {
                    type: 'array',
                    items: { $ref: getSchemaPath(AdminOrderEntity) },
                },
                total: { type: 'number', example: 320 },
                page: { type: 'number', example: 1 },
                limit: { type: 'number', example: 25 },
                totalPages: { type: 'number', example: 13 },
            },
        },
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    async findAll(@Query() query: QueryAdminOrdersDto) {
        return this.adminOrdersService.findAll(query);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get any order by ID' })
    @ApiParam({ name: 'id', description: 'Order CUID' })
    @ApiOkResponse({ type: AdminOrderEntity, description: 'Order details' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Order not found' })
    async findOne(@Param('id') id: string) {
        return this.adminOrdersService.findOne(id);
    }

    @Post(':id/cancel')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Cancel a pending order' })
    @ApiParam({ name: 'id', description: 'Order CUID' })
    @ApiOkResponse({ type: AdminOrderEntity, description: 'Order cancelled' })
    @ApiBadRequestResponse({
        description: 'The order is not PENDING',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Order not found' })
    async cancel(@Param('id') id: string) {
        return this.adminOrdersService.cancel(id);
    }

    @Post(':id/mark-paid')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Mark a pending order as paid',
        description:
            'Manual/offline settlement. Does not activate or renew a subscription.',
    })
    @ApiParam({ name: 'id', description: 'Order CUID' })
    @ApiOkResponse({ type: AdminOrderEntity, description: 'Order paid' })
    @ApiBadRequestResponse({
        description: 'The order is not PENDING',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Order not found' })
    async markPaid(@Param('id') id: string) {
        return this.adminOrdersService.markPaid(id);
    }

    @Post(':id/refund')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Mark a paid order as refunded',
        description:
            'Records the refund on the order only; no payment channel refund is issued.',
    })
    @ApiParam({ name: 'id', description: 'Order CUID' })
    @ApiOkResponse({ type: AdminOrderEntity, description: 'Order refunded' })
    @ApiBadRequestResponse({
        description: 'The order is not PAID',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Order not found' })
    async refund(@Param('id') id: string) {
        return this.adminOrdersService.refund(id);
    }
}
