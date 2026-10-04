import {
    Body,
    Controller,
    Headers,
    HttpCode,
    HttpStatus,
    Post,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiHeader,
    ApiOkResponse,
    ApiBody,
    ApiUnauthorizedResponse,
    ApiBadRequestResponse,
} from '@nestjs/swagger';
import { ProbesService } from './probes.service';
import { ReportProbeResultsDto } from './dto';
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
    constructor(private readonly probesService: ProbesService) {}

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
}
