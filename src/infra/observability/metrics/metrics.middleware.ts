import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { Request, Response } from 'express';

import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsMiddleware implements NestMiddleware {
    constructor(private readonly metricsService: MetricsService) {}

    /**
     * 不做应用层鉴权：本服务部署在 LB → nginx 之后，`request.ip` 拿到的永远是
     * 上游代理地址，按 IP 判断来源在代理后不可靠。`/metrics` 的访问控制放在
     * 网络层（LB / nginx 白名单，或干脆不把该路径暴露到公网）。
     */
    async use(_request: Request, response: Response): Promise<void> {
        response.type(this.metricsService.getContentType());
        response.send(await this.metricsService.getMetrics());
    }
}
