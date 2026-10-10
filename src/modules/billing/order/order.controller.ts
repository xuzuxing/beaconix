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
import { CreateOrderDto } from './dto';
import { OrderEntity } from './entities';
import { OrderService } from './order.service';

@ApiTags('Billing / Orders')
@ApiBearerAuth('access-token')
@Controller()
export class OrderController {
    constructor(private readonly orderService: OrderService) {}

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
}
