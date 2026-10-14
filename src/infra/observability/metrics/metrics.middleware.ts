import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { Request, Response } from 'express';

import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsMiddleware implements NestMiddleware {
    constructor(private readonly metricsService: MetricsService) {}

    async use(_request: Request, response: Response): Promise<void> {
        response.type(this.metricsService.getContentType());
        response.send(await this.metricsService.getMetrics());
    }
}
