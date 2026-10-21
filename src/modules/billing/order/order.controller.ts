import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
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
import { CurrentUser, Roles } from '../../../common/decorators';
import { OrgMemberGuard, RolesGuard } from '../../../common/guards';
import type { JwtPayload } from '../../../common/interfaces/jwt-payload.interface';
import { RefundService, toUserRefundView } from '../refund/refund.service';
import { CreateOrderDto, RequestRefundDto } from './dto';
import { OrderEntity } from './entities';
import { OrderService } from './order.service';

@ApiTags('Billing / Orders')
@ApiBearerAuth('access-token')
@Controller()
export class OrderController {
    constructor(
        private readonly orderService: OrderService,
        private readonly refundService: RefundService,
    ) {}

    @Post('organizations/:orgId/orders')
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @ApiOperation({ summary: 'Create a purchase order' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiBody({ type: CreateOrderDto })
    @ApiCreatedResponse({ type: OrderEntity, description: 'Order created' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    async create(
        @Param('orgId') orgId: string,
        @CurrentUser() user: JwtPayload,
        @Body() dto: CreateOrderDto,
    ) {
        return this.orderService.create(orgId, user.sub, dto);
    }

    @Get('organizations/:orgId/orders')
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'List orders of the organization' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiOkResponse({ type: [OrderEntity], description: 'Orders' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    async findAll(@Param('orgId') orgId: string) {
        return this.orderService.findAll(orgId);
    }

    @Get('orders/:id')
    @ApiOperation({ summary: 'Get an order by ID' })
    @ApiParam({ name: 'id', description: 'Order CUID' })
    @ApiOkResponse({ type: OrderEntity, description: 'Order details' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiNotFoundResponse({ description: 'Order not found' })
    async findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
        return this.orderService.findOne(id, user.sub);
    }

    @Post('orders/:id/cancel')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Cancel a pending order' })
    @ApiParam({ name: 'id', description: 'Order CUID' })
    @ApiOkResponse({ type: OrderEntity, description: 'Order cancelled' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiNotFoundResponse({ description: 'Order not found' })
    async cancel(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
        return this.orderService.cancel(id, user.sub);
    }

    /**
     * 退款试算：命中哪条政策、能退多少、订阅会怎样。
     *
     * 只读接口，成员都能看；`selfServiceEnabled` 告诉前端是否显示「申请退款」按钮
     * （由 `billing.refund.userSelfService` 控制）。
     */
    @Get('orders/:id/refund-quote')
    @UseGuards(OrgMemberGuard)
    @ApiOperation({
        summary: 'Quote a refund for an order',
        description:
            'Returns the matched policy, the refundable amount in cents, how the subscription will be affected and whether self-service refunds are open.',
    })
    @ApiParam({ name: 'id', description: 'Order CUID' })
    @ApiOkResponse({ description: 'Refund quote' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    @ApiNotFoundResponse({ description: 'Order not found' })
    async quoteRefund(
        @Param('id') id: string,
        @CurrentUser() user: JwtPayload,
    ) {
        const { quote, config } = await this.refundService.quote(
            id,
            new Date(),
            user.sub,
        );

        return { ...quote, selfServiceEnabled: config.userSelfService };
    }

    /**
     * 用户自助申请退款。
     *
     * 金额由服务端按政策算出，客户端只能附理由；是否立即执行取决于
     * `billing.refund.autoApproveLimit`（默认 0 = 全部人工审批）。
     */
    @Post('orders/:id/refunds')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @ApiOperation({
        summary: 'Request a refund (self-service)',
        description:
            'Requires `billing.refund.userSelfService`. Amounts under `billing.refund.autoApproveLimit` are executed immediately, larger ones wait for admin approval.',
    })
    @ApiParam({ name: 'id', description: 'Order CUID' })
    @ApiBody({ type: RequestRefundDto })
    @ApiOkResponse({ description: 'Refund request recorded' })
    @ApiForbiddenResponse({
        description: 'Insufficient role or self-service refunds are disabled',
    })
    async requestRefund(
        @Param('id') id: string,
        @CurrentUser() user: JwtPayload,
        @Body() dto: RequestRefundDto,
    ) {
        const refund = await this.refundService.create({
            orderId: id,
            reason: dto.reason,
            requestedBy: user.sub,
            actorUserId: user.sub,
            origin: 'USER',
        });

        return toUserRefundView(refund);
    }

    @Get('orders/:id/refunds')
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'List refunds of an order' })
    @ApiParam({ name: 'id', description: 'Order CUID' })
    @ApiOkResponse({ description: 'Refund progress of the order' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiNotFoundResponse({ description: 'Order not found' })
    async listRefunds(
        @Param('id') id: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.refundService.listForOrder(id, user.sub);
    }
}
