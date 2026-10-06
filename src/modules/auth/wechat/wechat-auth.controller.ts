import {
    Controller,
    Get,
    Post,
    Body,
    Query,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiBody,
    ApiOkResponse,
    ApiBadRequestResponse,
    ApiForbiddenResponse,
    ApiTooManyRequestsResponse,
    ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../../common/decorators';
import { WechatAuthService } from './wechat-auth.service';
import {
    WechatAuthorizeUrlDto,
    WechatWebLoginDto,
    WechatMiniProgramLoginDto,
} from './dto';
import { WechatAuthResponseEntity, WechatAuthorizeUrlEntity } from './entities';

@ApiTags('Auth / WeChat')
@Controller('auth/wechat')
export class WechatAuthController {
    constructor(private readonly wechatAuthService: WechatAuthService) {}

    @Post('web/login')
    @Public()
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { ttl: 60000, limit: 5 } })
    @ApiOperation({
        summary: 'WeChat website QR scan login',
        description:
            'Exchanges the `code` WeChat appended to the website-app redirect URL after a successful scan, then returns Beacon auth tokens. New WeChat users are provisioned automatically with a starter organization.',
    })
    @ApiBody({ type: WechatWebLoginDto })
    @ApiOkResponse({
        type: WechatAuthResponseEntity,
        description: 'WeChat website login successful',
    })
    @ApiBadRequestResponse({ description: 'Invalid or expired code' })
    @ApiForbiddenResponse({ description: 'Account is deactivated' })
    @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
    @ApiServiceUnavailableResponse({
        description: 'WeChat website login is not configured',
    })
    webLogin(@Body() dto: WechatWebLoginDto) {
        return this.wechatAuthService.webLogin(dto);
    }

    @Get('web/authorize-url')
    @Public()
    @Throttle({ default: { ttl: 60000, limit: 10 } })
    @ApiOperation({
        summary: 'Build WeChat website QR-connect URL',
        description:
            'Returns the `open.weixin.qq.com/connect/qrconnect` URL the web client should redirect to (or embed) to display the scan-to-login QR code.',
    })
    @ApiOkResponse({
        type: WechatAuthorizeUrlEntity,
        description: 'QR-connect URL built successfully',
    })
    @ApiBadRequestResponse({ description: 'Invalid redirectUri' })
    @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
    @ApiServiceUnavailableResponse({
        description: 'WeChat website login is not configured',
    })
    webAuthorizeUrl(@Query() dto: WechatAuthorizeUrlDto) {
        return this.wechatAuthService.getWebAuthorizeUrl(dto);
    }

    @Post('miniprogram/login')
    @Public()
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { ttl: 60000, limit: 5 } })
    @ApiOperation({
        summary: 'WeChat mini program login (code2Session)',
        description:
            'Exchanges the `wx.login()` code via WeChat `jscode2session`, then returns Beacon auth tokens. New WeChat users are provisioned automatically with a starter organization.',
    })
    @ApiBody({ type: WechatMiniProgramLoginDto })
    @ApiOkResponse({
        type: WechatAuthResponseEntity,
        description: 'Mini program login successful',
    })
    @ApiBadRequestResponse({ description: 'Invalid or expired code' })
    @ApiForbiddenResponse({ description: 'Account is deactivated' })
    @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
    @ApiServiceUnavailableResponse({
        description: 'WeChat mini program login is not configured',
    })
    miniProgramLogin(@Body() dto: WechatMiniProgramLoginDto) {
        return this.wechatAuthService.miniProgramLogin(dto);
    }
}
