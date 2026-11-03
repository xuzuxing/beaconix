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
import { ReportRumErrorDto } from '../dto';
import { RumIngestService } from './rum-ingest.service';

@ApiTags('RUM Ingestion')
@Controller('rum')
export class RumIngestController {
    constructor(private readonly ingest: RumIngestService) {}

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
}
