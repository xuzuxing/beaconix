import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
} from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiBody,
    ApiConflictResponse,
    ApiForbiddenResponse,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
    ApiTooManyRequestsResponse,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from '../auth.service';
import { AuthResponseEntity } from '../entities';
import { CurrentUser, Public, RequestMeta } from '../../../common/decorators';
import type {
    JwtPayload,
    RequestMeta as RequestMetaShape,
} from '../../../common/interfaces';
import { TwoFactorService } from './two-factor.service';
import {
    DisableTwoFactorDto,
    EnableTwoFactorDto,
    RegenerateRecoveryCodesDto,
    SetupTwoFactorDto,
    VerifyTwoFactorLoginDto,
} from './dto';
import {
    RecoveryCodesEntity,
    TwoFactorSetupEntity,
    TwoFactorStatusEntity,
} from './entities';

@ApiTags('Auth / Two-Factor')
@Controller('auth/2fa')
export class TwoFactorController {
    constructor(
        private readonly twoFactorService: TwoFactorService,
        private readonly authService: AuthService,
    ) {}

    @Post('verify-login')
    @Public()
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { ttl: 60000, limit: 5 } })
    @ApiOperation({
        summary: 'Complete 2FA login with a TOTP or recovery code',
        description:
            'Verifies the challenge returned by POST /auth/login and, on success, issues access + refresh tokens.',
    })
    @ApiBody({ type: VerifyTwoFactorLoginDto })
    @ApiOkResponse({
        type: AuthResponseEntity,
        description: 'Second factor verified. Tokens returned.',
    })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({
        description: 'Invalid or expired two-factor challenge or code',
    })
    @ApiTooManyRequestsResponse({
        description: 'Too many failed attempts or rate limit exceeded',
    })
    async verifyLogin(
        @Body() dto: VerifyTwoFactorLoginDto,
        @RequestMeta() meta: RequestMetaShape,
    ) {
        const { user } = await this.twoFactorService.verifyLogin(dto, meta);
        return this.authService.issueTokensForUser(user);
    }

    @Post('setup')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('access-token')
    @Throttle({ default: { ttl: 60000, limit: 3 } })
    @ApiOperation({
        summary: 'Start 2FA enrollment (returns QR + setup token)',
        description:
            'Validates the current password and returns a one-time setup token, the otpauth URI and a QR image. The secret is only persisted after POST /auth/2fa/enable.',
    })
    @ApiBody({ type: SetupTwoFactorDto })
    @ApiOkResponse({
        type: TwoFactorSetupEntity,
        description: 'Enrollment started',
    })
    @ApiBadRequestResponse({
        description: 'Validation failed or password-based account required',
    })
    @ApiConflictResponse({
        description: 'Two-factor authentication is already enabled',
    })
    @ApiUnauthorizedResponse({ description: 'Current password is incorrect' })
    @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
    async setup(
        @CurrentUser() user: JwtPayload,
        @Body() dto: SetupTwoFactorDto,
        @RequestMeta() meta: RequestMetaShape,
    ) {
        return this.twoFactorService.setup(user.sub, dto, meta);
    }

    @Post('enable')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('access-token')
    @Throttle({ default: { ttl: 60000, limit: 5 } })
    @ApiOperation({
        summary: 'Confirm 2FA enrollment and return recovery codes',
        description:
            'Verifies the setup token and a TOTP code, then enables 2FA, stores the encrypted secret and returns one-time recovery codes.',
    })
    @ApiBody({ type: EnableTwoFactorDto })
    @ApiOkResponse({
        type: RecoveryCodesEntity,
        description: 'Two-factor authentication enabled',
    })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiConflictResponse({
        description: 'Two-factor authentication is already enabled',
    })
    @ApiUnauthorizedResponse({
        description: 'Invalid setup token or TOTP code',
    })
    @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
    async enable(
        @CurrentUser() user: JwtPayload,
        @Body() dto: EnableTwoFactorDto,
        @RequestMeta() meta: RequestMetaShape,
    ) {
        return this.twoFactorService.enable(user.sub, dto, meta);
    }

    @Get('status')
    @ApiBearerAuth('access-token')
    @ApiOperation({
        summary: 'Get 2FA status',
        description:
            'Returns whether 2FA is enabled and how many recovery codes remain.',
    })
    @ApiOkResponse({
        type: TwoFactorStatusEntity,
        description: 'Current 2FA status',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    async status(@CurrentUser() user: JwtPayload) {
        return this.twoFactorService.getStatus(user.sub);
    }

    @Post('recovery-codes')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('access-token')
    @Throttle({ default: { ttl: 60000, limit: 3 } })
    @ApiOperation({
        summary: 'Regenerate recovery codes',
        description:
            'Rotates recovery codes after validating the current password and a TOTP/recovery code. Existing codes are invalidated.',
    })
    @ApiBody({ type: RegenerateRecoveryCodesDto })
    @ApiOkResponse({
        type: RecoveryCodesEntity,
        description: 'Recovery codes regenerated',
    })
    @ApiBadRequestResponse({
        description: 'Validation failed or 2FA is not enabled',
    })
    @ApiUnauthorizedResponse({
        description: 'Current password or second factor is incorrect',
    })
    @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
    async regenerateRecoveryCodes(
        @CurrentUser() user: JwtPayload,
        @Body() dto: RegenerateRecoveryCodesDto,
        @RequestMeta() meta: RequestMetaShape,
    ) {
        return this.twoFactorService.regenerateRecoveryCodes(
            user.sub,
            dto,
            meta,
        );
    }

    @Post('disable')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('access-token')
    @Throttle({ default: { ttl: 60000, limit: 3 } })
    @ApiOperation({
        summary: 'Disable 2FA',
        description:
            'Disables 2FA after validating the current password and a TOTP/recovery code. All sessions are revoked.',
    })
    @ApiBody({ type: DisableTwoFactorDto })
    @ApiOkResponse({ description: 'Two-factor authentication disabled' })
    @ApiBadRequestResponse({
        description: 'Validation failed or 2FA is not enabled',
    })
    @ApiUnauthorizedResponse({
        description: 'Current password or second factor is incorrect',
    })
    @ApiForbiddenResponse({ description: 'Account is deactivated' })
    @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
    async disable(
        @CurrentUser() user: JwtPayload,
        @Body() dto: DisableTwoFactorDto,
        @RequestMeta() meta: RequestMetaShape,
    ) {
        return this.twoFactorService.disable(user.sub, dto, meta);
    }
}
