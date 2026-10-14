import {
    BadRequestException,
    Controller,
    Get,
    Head,
    HttpCode,
    HttpStatus,
    Param,
    Render,
    Res,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiOkResponse,
    ApiBadRequestResponse,
    ApiForbiddenResponse,
    ApiDefaultResponse,
    ApiParam,
    ApiServiceUnavailableResponse,
    ApiProperty,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AppService, HealthStatus } from './app.service';
import { Public } from './common/decorators';
import { toIsoString } from './common/utils/date.util';
import { StatusPagesService } from './modules/status-pages/status-pages.service';

class DatabaseHealthDto {
    @ApiProperty({ enum: ['up', 'down'], example: 'up' })
    status: string;

    @ApiProperty({
        example: 3,
        description: 'Response time in ms',
        required: false,
    })
    responseTime?: number;

    @ApiProperty({
        required: false,
        description: 'Error message if database is down',
    })
    error?: string;
}

class ServicesDto {
    @ApiProperty({ type: DatabaseHealthDto })
    database: DatabaseHealthDto;
}

class MemoryDto {
    @ApiProperty({
        example: 54321152,
        description: 'Heap memory used in bytes',
    })
    heapUsed: number;

    @ApiProperty({
        example: 75497472,
        description: 'Total heap memory in bytes',
    })
    heapTotal: number;

    @ApiProperty({
        example: 95420416,
        description: 'Resident set size in bytes',
    })
    rss: number;

    @ApiProperty({ example: 1234567, description: 'External memory in bytes' })
    external: number;
}

class CpuDto {
    @ApiProperty({
        example: 123456,
        description: 'User CPU time in microseconds',
    })
    user: number;

    @ApiProperty({
        example: 65432,
        description: 'System CPU time in microseconds',
    })
    system: number;
}

class HealthResponseDto {
    @ApiProperty({
        enum: ['healthy', 'degraded', 'unhealthy'],
        example: 'healthy',
    })
    status: string;

    @ApiProperty({
        example: 12345.67,
        description: 'Process uptime in seconds',
    })
    uptime: number;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    timestamp: string;

    @ApiProperty({ example: 'beaconix' })
    appName: string;

    @ApiProperty({ example: 'development' })
    environment: string;

    @ApiProperty({ type: ServicesDto })
    services: ServicesDto;

    @ApiProperty({ type: MemoryDto })
    memory: MemoryDto;

    @ApiProperty({ type: CpuDto })
    cpu: CpuDto;
}

class StatusTestResponseDto {
    @ApiProperty({ type: 'integer', minimum: 200, maximum: 599, example: 200 })
    statusCode: number;
}

@ApiTags('Health')
@SkipThrottle()
@Controller()
export class AppController {
    constructor(
        private readonly appService: AppService,
        private readonly statusPagesService: StatusPagesService,
    ) {}

    @Get()
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Health check',
        description:
            'Returns the health status of the application including database connectivity, memory usage, CPU usage, and uptime.',
    })
    @ApiOkResponse({
        description: 'Service is healthy',
        type: HealthResponseDto,
    })
    @ApiServiceUnavailableResponse({
        description: 'Service is unhealthy — one or more dependencies are down',
    })
    async getHealth(): Promise<HealthStatus> {
        return this.appService.getHealth();
    }

    @Get('status')
    @Public()
    @ApiOperation({
        summary: 'Return the default HTTP 200 for monitor testing',
    })
    @ApiOkResponse({ type: StatusTestResponseDto })
    defaultStatus(@Res({ passthrough: true }) response: Response) {
        return this.testStatus('200', response);
    }

    @Get('status/:code')
    @Public()
    @ApiOperation({
        summary: 'Return a requested HTTP status for monitor testing',
        description:
            'Numeric codes from 200 to 599 return that HTTP status. ' +
            'Omit the code to default to 200. Non-numeric values preserve public status page slugs.',
    })
    @ApiParam({
        name: 'code',
        description:
            'HTTP status code (200-599), or an existing status page slug',
        example: '400',
    })
    @ApiOkResponse({ type: StatusTestResponseDto })
    @ApiBadRequestResponse({
        description: 'Requested HTTP 400, or a numeric code outside 200-599',
    })
    @ApiForbiddenResponse({ type: StatusTestResponseDto })
    @ApiDefaultResponse({
        description:
            'The requested HTTP status and matching statusCode; HTTP 204, 205 and 304 have no body. Non-numeric slugs return the existing public status page response.',
        type: StatusTestResponseDto,
    })
    testStatus(
        @Param('code') code: string = '200',
        @Res({ passthrough: true }) response: Response,
    ) {
        // This route shares its shape with /status/:slug.
        const numericCode = /^\d+$/.test(code);
        if (!numericCode && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code)) {
            return this.statusPagesService.getPublicBySlug(code);
        }
        const statusCode = Number(code);
        if (
            !numericCode ||
            !Number.isInteger(statusCode) ||
            statusCode < 200 ||
            statusCode > 599
        ) {
            throw new BadRequestException(
                'Status code must be an integer between 200 and 599',
            );
        }
        response.status(statusCode);
        return { statusCode };
    }

    @Get('monitor-test')
    @Public()
    @Render('monitor-test')
    monitorTestPage() {
        return {
            title: 'Beacon Monitor Test',
            apiBase: '/api',
            renderedAt: toIsoString(Date.now()),
        };
    }

    @Get('monitoring-test')
    @Public()
    @Render('monitoring-test')
    monitoringTestPage() {
        return {
            title: 'Beacon Monitoring Test',
            apiBase: '/api',
            renderedAt: toIsoString(Date.now()),
        };
    }

    @Get('billing-test')
    @Public()
    @Render('billing-test')
    billingTestPage() {
        return {
            title: 'Beacon Billing Test',
            apiBase: '/api',
            renderedAt: toIsoString(Date.now()),
        };
    }

    @Get('upload-test')
    @Public()
    @Render('upload-test')
    uploadTestPage() {
        return {
            title: 'Beacon Upload Test',
            apiBase: '/api',
            renderedAt: toIsoString(Date.now()),
        };
    }

    @Get('rules-test')
    @Public()
    @Render('rules-test')
    rulesTestPage() {
        return {
            title: 'Beacon Rule Engine Test',
            apiBase: '/api',
            renderedAt: toIsoString(Date.now()),
        };
    }

    @Head()
    @Public()
    @HttpCode(HttpStatus.OK)
    headHealth(@Res() res: Response): void {
        res.end();
    }
}
