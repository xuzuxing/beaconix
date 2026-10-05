import {
    Body,
    Controller,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    Post,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser, Public } from '../../../common/decorators';
import type { JwtPayload } from '../../../common/interfaces/jwt-payload.interface';
import { CreatePaymentDto } from './dto';
import { PaymentService } from './payment.service';

@ApiTags('Billing / Payment')
@ApiBearerAuth('access-token')
@Controller()
export class PaymentController {
    constructor(private readonly paymentService: PaymentService) {}

    @Post('orders/:id/pay')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Create a WeChat payment for an order' })
    @ApiParam({ name: 'id', description: 'Order UUID' })
    @ApiBody({ type: CreatePaymentDto })
    @ApiOkResponse({
        description: 'WeChat JSAPI parameters for wx.requestPayment',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    async pay(
        @Param('id') id: string,
        @CurrentUser() user: JwtPayload,
        @Body() dto: CreatePaymentDto,
    ) {
        return this.paymentService.createPayment(id, user.sub, dto);
    }

    @Post('payment/wechat/callback')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'WeChat Pay callback (idempotent)' })
    @ApiBody({ description: 'WeChat Pay decrypted callback body' })
    @ApiOkResponse({ description: '{ code: "SUCCESS" | "FAIL" }' })
    async wechatCallback(
        @Headers('wechatpay-signature') signature: string,
        @Body() body: unknown,
    ) {
        return this.paymentService.handleWechatCallback(
            JSON.stringify(body),
            signature,
        );
    }
}
