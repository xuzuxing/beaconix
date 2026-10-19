import {
    Body,
    Controller,
    Get,
    Headers,
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
    ApiQuery,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ProbeEnrollmentService } from './probe-enrollment.service';
import { ProbesService } from './probes.service';
import { PROBE_SECRET_HEADER } from './probe-ingest.controller';
import {
    ApproveEnrollmentDto,
    CreateEnrollTokenDto,
    DeviceAuthorizationDto,
    DeviceTokenDto,
    RedeemEnrollmentDto,
} from './dto';
import { CurrentUser, Public, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards';
import type { JwtPayload } from '../../common/interfaces';

/**
 * Probe enrollment API.
 *
 * Registered with an empty controller prefix so a single class can serve both
 * `/probes/enroll/*` (agent-facing) and
 * `/organizations/:orgId/probes/enroll-token` (web-facing) without creating a
 * circular module dependency on ProbesModule.
 */
@ApiTags('Probes (enrollment)')
@Controller()
export class ProbeEnrollmentController {
    constructor(
        private readonly enrollmentService: ProbeEnrollmentService,
        private readonly probesService: ProbesService,
    ) {}

    @Post('probes/enroll/device')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Start a device authorization (CLI: beaconix-probe login)',
    })
    @ApiBody({ type: DeviceAuthorizationDto })
    @ApiOkResponse({
        description:
            '{ deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval }',
    })
    async device(@Body() dto: DeviceAuthorizationDto) {
        return this.enrollmentService.startDeviceAuthorization(dto);
    }

    @Post('probes/enroll/token')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Poll a device authorization for its credential' })
    @ApiBody({ type: DeviceTokenDto })
    @ApiOkResponse({
        description:
            '{ status: pending|approved|denied|expired, credential?: { probeId, secret, apiUrl } }',
    })
    async token(@Body() dto: DeviceTokenDto) {
        return this.enrollmentService.pollDeviceToken(dto.deviceCode);
    }

    @Get('probes/enroll/activate')
    @Public()
    @ApiOperation({
        summary: 'Details of a pending enrollment for the confirmation page',
    })
    @ApiQuery({ name: 'code', required: true, description: 'User code' })
    @ApiOkResponse({
        description: '{ userCode, status, requestedAt, client }',
    })
    @ApiNotFoundResponse({ description: 'Unknown or expired user code' })
    async activate(@Query('code') code: string) {
        return this.enrollmentService.describeActivation(code);
    }

    @Post('probes/enroll/approve')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('access-token')
    @ApiOperation({
        summary: 'Approve an enrollment; SUPER_ADMIN may create a SYSTEM probe',
    })
    @ApiBody({ type: ApproveEnrollmentDto })
    @ApiOkResponse({
        description:
            '{ probeId, organizationId, scope, status } (organizationId is null for SYSTEM)',
    })
    @ApiBadRequestResponse({
        description: 'Unknown, expired or already settled user code',
    })
    @ApiForbiddenResponse({
        description: 'Requires ADMIN in the target organization',
    })
    async approve(
        @CurrentUser() user: JwtPayload,
        @Body() dto: ApproveEnrollmentDto,
    ) {
        return this.enrollmentService.approve(user.sub, user.globalRole, dto);
    }

    @Post('probes/enroll/redeem')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            'Redeem a web-issued one-time token (CLI: beaconix-probe enroll)',
    })
    @ApiBody({ type: RedeemEnrollmentDto })
    @ApiOkResponse({ description: '{ probeId, secret, apiUrl }' })
    @ApiUnauthorizedResponse({
        description: 'Unknown or already used enrollment token',
    })
    async redeem(@Body() dto: RedeemEnrollmentDto) {
        return this.enrollmentService.redeem(dto);
    }

    @Post('organizations/:orgId/probes/enroll-token')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @ApiBearerAuth('access-token')
    @ApiOperation({
        summary: 'Mint a one-time install command for a new probe',
    })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiBody({ type: CreateEnrollTokenDto })
    @ApiOkResponse({
        description: '{ token, expiresAt, command, apiUrl }',
    })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    async createEnrollToken(
        @CurrentUser() user: JwtPayload,
        @Param('orgId') orgId: string,
        @Body() dto: CreateEnrollTokenDto,
    ) {
        return this.enrollmentService.createEnrollToken(
            user.sub,
            user.globalRole,
            orgId,
            dto,
        );
    }

    @Post('probes/revoke')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Revoke the presented probe credential (x-probe-secret)',
    })
    @ApiOkResponse({ description: '{ ok, probeId, revokedSecretId }' })
    @ApiUnauthorizedResponse({ description: 'Unknown probe secret' })
    async revoke(@Headers(PROBE_SECRET_HEADER) secret: string) {
        return this.probesService.revokeBySecret(secret);
    }
}
