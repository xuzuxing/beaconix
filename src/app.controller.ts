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
    ApiProperty,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from './common/decorators';
import { toIsoString } from './common/utils/date.util';
import { StatusPagesService } from './modules/status-pages/status-pages.service';

class StatusTestResponseDto {
    @ApiProperty({ type: 'integer', minimum: 200, maximum: 599, example: 200 })
    statusCode: number;
}
@ApiTags('Root')
@SkipThrottle()
@Controller()
export class AppController {
    constructor(private readonly statusPagesService: StatusPagesService) {}

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
