import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Post,
    Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
    ApiAcceptedResponse,
    ApiBadRequestResponse,
    ApiNotFoundResponse,
    ApiOperation,
    ApiServiceUnavailableResponse,
    ApiTags,
    ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../../common/decorators';
import {
    ReportRumErrorDto,
    ReportRumEventDto,
    ReportRumReplayDto,
} from '../dto';
import { RumEventsService } from '../events/rum-events.service';
import { RumReplaysService } from '../replays/rum-replays.service';
import { RumIngestService } from './rum-ingest.service';

@ApiTags('RUM Ingestion')
@Controller('rum')
export class RumIngestController {
    constructor(
        private readonly ingest: RumIngestService,
        private readonly events: RumEventsService,
        private readonly replays: RumReplaysService,
    ) {}

    @Post('errors')
    @Public()
    @SkipThrottle({ default: true })
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({ summary: 'Report a browser error to a RUM app' })
    @ApiAcceptedResponse({ description: '{ accepted: true }' })
    @ApiBadRequestResponse({ description: 'Invalid payload' })
    @ApiNotFoundResponse({ description: 'RUM app unavailable' })
    @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
    @ApiServiceUnavailableResponse({ description: 'Rate limiter unavailable' })
    reportError(@Body() dto: ReportRumErrorDto, @Req() request: Request) {
        return this.ingest.reportError(dto, request.ip || 'unknown');
    }

    @Post('events')
    @Public()
    @SkipThrottle({ default: true })
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({ summary: 'Report an analytics event to a RUM app' })
    @ApiAcceptedResponse({ description: '{ accepted: true }' })
    @ApiBadRequestResponse({ description: 'Invalid payload' })
    @ApiNotFoundResponse({ description: 'RUM app unavailable' })
    @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
    @ApiServiceUnavailableResponse({ description: 'Rate limiter unavailable' })
    reportEvent(@Body() dto: ReportRumEventDto, @Req() request: Request) {
        return this.events.report(dto, request.ip || 'unknown');
    }

    @Post('replays')
    @Public()
    @SkipThrottle({ default: true })
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({ summary: 'Upload a sanitized session replay chunk' })
    @ApiAcceptedResponse({ description: '{ accepted: true }' })
    @ApiBadRequestResponse({ description: 'Invalid or oversized payload' })
    @ApiNotFoundResponse({ description: 'RUM app unavailable' })
    @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
    @ApiServiceUnavailableResponse({ description: 'Rate limiter unavailable' })
    reportReplay(@Body() dto: ReportRumReplayDto, @Req() request: Request) {
        return this.replays.report(dto, request.ip || 'unknown');
    }
}
