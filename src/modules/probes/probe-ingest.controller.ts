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
    ApiTags,
    ApiOperation,
    ApiHeader,
    ApiOkResponse,
    ApiBody,
    ApiParam,
    ApiUnauthorizedResponse,
    ApiBadRequestResponse,
} from '@nestjs/swagger';
import { ProbesService } from './probes.service';
import { ProbeValidationService } from './probe-validation.service';
import { AnswerProbeValidationDto, ReportProbeResultsDto } from './dto';
import { Public } from '../../common/decorators';

/** Header carrying the probe shared secret. */
export const PROBE_SECRET_HEADER = 'x-probe-secret';

/**
 * Agent-facing API. These routes are unauthenticated on purpose: probes
 * authenticate with their shared secret instead of a user JWT.
 */
@ApiTags('Probes (agent API)')
@Controller('probes')
export class ProbeIngestController {
    constructor(
        private readonly probesService: ProbesService,
        private readonly probeValidationService: ProbeValidationService,
    ) {}

    @Post('heartbeat')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Report a heartbeat and fetch the monitors to check',
    })
    @ApiHeader({
        name: PROBE_SECRET_HEADER,
        required: true,
        description: 'Probe shared secret',
    })
    @ApiOkResponse({
        description:
            '{ probe, monitors: [{ id, name, type, target, interval, timeout, expectedStatus }], serverTime }',
    })
    @ApiUnauthorizedResponse({
        description: 'Missing, unknown or disabled probe',
    })
    async heartbeat(@Headers(PROBE_SECRET_HEADER) secret: string) {
        return this.probesService.recordHeartbeat(secret);
    }

    @Post('results')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Report batch check results' })
    @ApiHeader({
        name: PROBE_SECRET_HEADER,
        required: true,
        description: 'Probe shared secret',
    })
    @ApiBody({ type: ReportProbeResultsDto })
    @ApiOkResponse({
        description:
            '{ accepted, applied, outcomes: [{ target, monitorId, status, changed }] }',
    })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({
        description: 'Missing, unknown or disabled probe',
    })
    async report(
        @Headers(PROBE_SECRET_HEADER) secret: string,
        @Body() dto: ReportProbeResultsDto,
    ) {
        return this.probesService.recordResults(secret, dto.results);
    }

    @Post('validation/pull')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Pull a pending validation challenge for this probe',
    })
    @ApiHeader({
        name: PROBE_SECRET_HEADER,
        required: true,
        description: 'Probe shared secret',
    })
    @ApiOkResponse({
        description:
            '{ validation: null | { validationId, challenge: { iv, tag, data }, expiresAt } }',
    })
    @ApiUnauthorizedResponse({
        description: 'Missing, unknown or disabled probe',
    })
    async pullValidation(@Headers(PROBE_SECRET_HEADER) secret: string) {
        return this.probeValidationService.pullForSecret(secret);
    }

    @Post('validation/:validationId/answer')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Submit the encrypted answer for a validation' })
    @ApiHeader({
        name: PROBE_SECRET_HEADER,
        required: true,
        description: 'Probe shared secret',
    })
    @ApiParam({
        name: 'validationId',
        description: 'Validation id returned by the pull endpoint',
    })
    @ApiBody({ type: AnswerProbeValidationDto })
    @ApiOkResponse({
        description: '{ validationId, ok, status, checkedAt }',
    })
    @ApiBadRequestResponse({
        description: 'Invalid, expired or already answered challenge',
    })
    @ApiUnauthorizedResponse({
        description: 'Missing, unknown or disabled probe',
    })
    async answerValidation(
        @Headers(PROBE_SECRET_HEADER) secret: string,
        @Param('validationId') validationId: string,
        @Body() dto: AnswerProbeValidationDto,
    ) {
        return this.probeValidationService.answerForSecret(
            secret,
            validationId,
            dto.answer,
        );
    }
}
