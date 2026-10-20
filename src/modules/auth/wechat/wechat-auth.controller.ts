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
    ApiCreatedResponse,
    ApiBadRequestResponse,
    ApiForbiddenResponse,
    ApiTooManyRequestsResponse,
    ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public, RequestMeta } from '../../../common/decorators';
import type { RequestMeta as RequestMetaShape } from '../../../common/interfaces';
import { WechatAuthService } from './wechat-auth.service';
import { WechatScanLoginService } from './wechat-scan-login.service';
import {
    WechatAuthorizeUrlDto,
    WechatWebLoginDto,
    WechatMiniProgramLoginDto,
    CreateWechatScanLoginDto,
    WechatScanLoginDto,
    QueryWechatScanLoginStatusDto,
} from './dto';
import {
    WechatAuthResponseEntity,
    WechatAuthorizeUrlEntity,
    WechatScanLoginQrcodeEntity,
    WechatScanLoginStatusEntity,
} from './entities';

@ApiTags('Auth / WeChat')
@Controller('auth/wechat')
export class WechatAuthController {
    constructor(
        private readonly wechatAuthService: WechatAuthService,
        private readonly wechatScanLoginService: WechatScanLoginService,
    ) {}

    @Post('web/login')
    @Public()
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { ttl: 60000, limit: 5 } })
    @ApiOperation({
        summary: 'WeChat website QR scan login',
        description:
            'Exchanges the `code` WeChat appended to the website-app redirect URL after a successful scan, then returns Beaconix auth tokens. New WeChat users are provisioned automatically with a starter organization.',
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
    webLogin(
        @Body() dto: WechatWebLoginDto,
        @RequestMeta() meta: RequestMetaShape,
    ) {
        return this.wechatAuthService.webLogin(dto, meta);
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
            'Exchanges the `wx.login()` code via WeChat `jscode2session`, then returns Beaconix auth tokens. New WeChat users are provisioned automatically with a starter organization.',
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
    miniProgramLogin(
        @Body() dto: WechatMiniProgramLoginDto,
        @RequestMeta() meta: RequestMetaShape,
    ) {
        return this.wechatAuthService.miniProgramLogin(dto, meta);
    }

    @Post('miniprogram/qrcode')
    @Public()
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ default: { ttl: 60000, limit: 10 } })
    @ApiOperation({
        summary: 'Create mini-program scan-login QR code',
        description:
            'Creates a Redis login ticket and a WeChat unlimited mini-program QR code carrying that ticket. The web client renders the returned base64 data URL and starts polling the status endpoint.',
    })
    @ApiBody({ type: CreateWechatScanLoginDto })
    @ApiCreatedResponse({
        type: WechatScanLoginQrcodeEntity,
        description: 'QR code created',
    })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
    @ApiServiceUnavailableResponse({
        description: 'WeChat mini program is not configured',
    })
    createQrCode(@Body() dto: CreateWechatScanLoginDto) {
        return this.wechatScanLoginService.createQrCode(dto);
    }

    @Post('miniprogram/scan-login')
    @Public()
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { ttl: 60000, limit: 10 } })
    @ApiOperation({
        summary: 'Mini-program scan-login confirmation',
        description:
            'Called by the mini program after the user scans the QR code. Exchanges the wx.login() code and marks the Redis login ticket as confirmed.',
    })
    @ApiBody({ type: WechatScanLoginDto })
    @ApiOkResponse({
        type: WechatAuthResponseEntity,
        description: 'Mini program logged in and web ticket confirmed',
    })
    @ApiBadRequestResponse({ description: 'Invalid/expired ticket or code' })
    @ApiForbiddenResponse({ description: 'Account is deactivated' })
    @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
    @ApiServiceUnavailableResponse({
        description: 'WeChat mini program is not configured',
    })
    scanLogin(
        @Body() dto: WechatScanLoginDto,
        @RequestMeta() meta: RequestMetaShape,
    ) {
        return this.wechatScanLoginService.scanLogin(dto, meta);
    }

    @Get('miniprogram/qrcode/status')
    @Public()
    @Throttle({ default: { ttl: 60000, limit: 30 } })
    @ApiOperation({
        summary: 'Long-poll mini-program scan-login status',
        description:
            'Web client polls this endpoint. It blocks while the ticket is PENDING/SCANNED, returns auth tokens when CONFIRMED, and EXPIRED when invalid or already consumed.',
    })
    @ApiOkResponse({
        type: WechatScanLoginStatusEntity,
        description: 'Current scan-login status',
    })
    @ApiBadRequestResponse({ description: 'Invalid ticket' })
    @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
    @ApiServiceUnavailableResponse({ description: 'Redis is unavailable' })
    qrCodeStatus(
        @Query() dto: QueryWechatScanLoginStatusDto,
        @RequestMeta() meta: RequestMetaShape,
    ) {
        return this.wechatScanLoginService.pollStatus(dto, meta);
    }
}
