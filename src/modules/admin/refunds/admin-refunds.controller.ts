import {
    Body,
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
    ApiBody,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuditLog, CurrentUser } from '../../../common/decorators';
import { SuperAdminGuard } from '../../../common/guards';
import type { JwtPayload } from '../../../common/interfaces/jwt-payload.interface';
import { AdminRefundsService } from './admin-refunds.service';
import {
    CloseAdminRefundDto,
    CreateAdminRefundDto,
    QueryAdminRefundsDto,
    QueryAdminRefundStatsDto,
} from './dto';
import { AdminRefundEntity } from './entities';

@ApiTags('Admin / Refunds')
@ApiBearerAuth('access-token')
@UseGuards(SuperAdminGuard)
@Controller('admin/refunds')
export class AdminRefundsController {
    constructor(private readonly adminRefundsService: AdminRefundsService) {}

    @Get()
    @ApiOperation({
        summary: 'List refunds across every tenant',
        description:
            'Cross-tenant refund query for SUPER_ADMIN. All filters are opt-in.',
    })
    @ApiOkResponse({ description: 'Paginated refunds' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    async findAll(@Query() query: QueryAdminRefundsDto) {
        return this.adminRefundsService.findAll(query);
    }

    /**
     * 试算：发起之前先看命中的政策、金额与订阅影响。
     *
     * 路径带 `quote/` 前缀，避免与 `:id` 路由冲突。
     */
    @Get('quote/:orderId')
    @ApiOperation({
        summary: 'Quote a refund for an order',
        description:
            'Returns the matched policy (cooling-off / prorated / expired), the amount in cents and how the subscription will be affected.',
    })
    @ApiParam({ name: 'orderId', description: 'Order CUID' })
    @ApiOkResponse({ description: 'Refund quote' })
    @ApiNotFoundResponse({ description: 'Order not found' })
    async quote(@Param('orderId') orderId: string) {
        return this.adminRefundsService.quote(orderId);
    }

    @Get('stats')
    @ApiOperation({
        summary: 'Refund reconciliation stats',
        description:
            'Aggregates refunds by status, channel and policy (amounts in cents) and lists the top failure reasons. Filters are opt-in.',
    })
    @ApiOkResponse({ description: 'Refund stats' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    async stats(@Query() query: QueryAdminRefundStatsDto) {
        return this.adminRefundsService.stats(query);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a refund by id' })
    @ApiParam({ name: 'id', description: 'Refund CUID' })
    @ApiOkResponse({ description: 'Refund detail' })
    @ApiNotFoundResponse({ description: 'Refund not found' })
    async findOne(@Param('id') id: string): Promise<AdminRefundEntity> {
        return this.adminRefundsService.findOne(id);
    }

    @Post()
    @HttpCode(HttpStatus.OK)
    @AuditLog({ entity: 'Refund' })
    @ApiOperation({
        summary: 'Create a refund for an order',
        description:
            'Runs the refund policy, records the refund, submits it to the channel and — when the channel answers synchronously — reclaims the subscription in the same transaction. Requires `billing.refund.enabled`.',
    })
    @ApiBody({ type: CreateAdminRefundDto })
    @ApiOkResponse({ description: 'Created refund' })
    @ApiBadRequestResponse({
        description:
            'Refunds disabled, order not refundable, an in-flight refund exists, or the manual amount is invalid',
    })
    async create(
        @Body() dto: CreateAdminRefundDto,
        @CurrentUser() user: JwtPayload,
    ): Promise<AdminRefundEntity> {
        return this.adminRefundsService.create(dto, user?.sub);
    }

    @Post(':id/approve')
    @HttpCode(HttpStatus.OK)
    @AuditLog({ entity: 'Refund', action: 'UPDATE' })
    @ApiOperation({
        summary: 'Approve a pending refund request',
        description:
            'Submits a user-initiated refund that exceeded `billing.refund.autoApproveLimit` to the payment channel.',
    })
    @ApiParam({ name: 'id', description: 'Refund CUID' })
    @ApiOkResponse({ description: 'Refund after approval' })
    @ApiBadRequestResponse({
        description: 'Only a PENDING refund can be approved',
    })
    async approve(
        @Param('id') id: string,
        @CurrentUser() user: JwtPayload,
    ): Promise<AdminRefundEntity> {
        return this.adminRefundsService.approve(id, user?.sub);
    }

    @Post(':id/retry')
    @HttpCode(HttpStatus.OK)
    @AuditLog({ entity: 'Refund', action: 'UPDATE' })
    @ApiOperation({
        summary: 'Retry a failed refund',
        description:
            'Resubmits with the same refund number, so the channel idempotency key prevents a double refund.',
    })
    @ApiParam({ name: 'id', description: 'Refund CUID' })
    @ApiOkResponse({ description: 'Refund after the retry' })
    @ApiBadRequestResponse({
        description: 'Only a FAILED refund can be retried',
    })
    async retry(@Param('id') id: string): Promise<AdminRefundEntity> {
        return this.adminRefundsService.retry(id);
    }

    @Post(':id/close')
    @HttpCode(HttpStatus.OK)
    @AuditLog({ entity: 'Refund', action: 'UPDATE' })
    @ApiOperation({
        summary: 'Close a refund that cannot complete',
        description: 'For rejected, unreachable or withdrawn refunds.',
    })
    @ApiParam({ name: 'id', description: 'Refund CUID' })
    @ApiOkResponse({ description: 'Closed refund' })
    async close(
        @Param('id') id: string,
        @Body() dto: CloseAdminRefundDto,
    ): Promise<AdminRefundEntity> {
        return this.adminRefundsService.close(id, dto.reason);
    }
}
