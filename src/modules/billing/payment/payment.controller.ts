import {
    Body,
    Controller,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Req,
    Res,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser, Public, SkipTransform } from '../../../common/decorators';
import type { JwtPayload } from '../../../common/interfaces/jwt-payload.interface';
import { CreatePaymentDto } from './dto';
import type { PaymentCallbackHeaders } from './payment-provider.interface';
import { PaymentService } from './payment.service';

/** Case-insensitive header lookup for Express/Nest header bags. */
function readHeader(
    headers: PaymentCallbackHeaders | undefined,
    name: string,
): string | undefined {
    if (!headers) return undefined;

    const target = name.toLowerCase();

    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== target) continue;
        return Array.isArray(value) ? value[0] : value;
    }

    return undefined;
}

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
    @SkipTransform()
    @ApiOperation({ summary: 'WeChat Pay callback (idempotent)' })
    @ApiBody({
        description:
            'WeChat Pay notification envelope with an encrypted resource',
    })
    @ApiOkResponse({ description: '{ code: "SUCCESS", message: "成功" }' })
    async wechatCallback(
        @Req() request: RawBodyRequest<Request>,
        @Headers() headers: PaymentCallbackHeaders,
        @Body() body: unknown,
        @Res({ passthrough: true }) response: Response,
    ) {
        // WeChat signs the exact bytes it sent, so verification must use the raw
        // payload captured by `rawBody: true` — never a re-serialized object.
        const rawBody =
            request.rawBody?.toString('utf8') ?? JSON.stringify(body);

        const result = await this.paymentService.handleWechatCallback(
            rawBody,
            readHeader(headers, 'wechatpay-signature') ?? '',
            headers,
        );

        // WeChat Pay V3 expects a bare acknowledgement body (no envelope) and a
        // non-2xx status for FAIL so it will retry.
        response.status(
            result.code === 'SUCCESS' ? HttpStatus.OK : HttpStatus.BAD_REQUEST,
        );

        return result;
    }
}
