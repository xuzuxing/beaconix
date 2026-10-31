import {
    CanActivate,
    ExecutionContext,
    Injectable,
    Logger,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { httpPath } from '../../config/http-path';
import type { Request, Response } from 'express';
import { GlobalRole } from '../../generated/prisma/enums';
// 直接引具体文件而不是 modules/settings 的 barrel：
// settings.controller 依赖 common/guards，经 barrel 会形成
// common/guards ↔ modules/settings 的循环，循环期间这里拿到 undefined，
// Nest 就会报 "can't resolve dependencies of the MaintenanceGuard"。
import { SettingsService } from '../../modules/settings/settings.service';
import { SKIP_MAINTENANCE_KEY } from '../decorators/skip-maintenance.decorator';

/** 维护期返回给客户端的建议重试间隔（秒） */
const RETRY_AFTER_SECONDS = 60;

/**
 * 维护期仍然放行的相对路径前缀，匹配时拼上配置的全局前缀。
 *
 * 这些是「维护期不能让系统失联」的入口：健康检查、登录/刷新（否则超管进不去、
 * 也就关不掉开关）、支付回调（放过会掉单）、探针上报（否则监控数据断层）、
 * 公开配置与公开状态页（前端要能显示维护提示、对外状态页要保持可达）。
 *
 * 匹配规则是「等于该前缀」或「以 `前缀/` 开头」，所以 `/api/status` 不会把
 * `/api/status-pages` 一起放行。新增对外区域时记得同步这里。
 */
const MAINTENANCE_EXEMPT_PREFIXES: readonly string[] = [
    '/health',
    '/status',
    '/auth',
    '/plans',
    '/settings/public',
    '/payment',
    '/probes',
];

function isExemptPath(path: string, globalPrefix: string): boolean {
    return MAINTENANCE_EXEMPT_PREFIXES.some((relative) => {
        const prefix = httpPath(globalPrefix, relative);
        return path === prefix || path.startsWith(`${prefix}/`);
    });
}

/**
 * 维护模式开关（`system.maintenanceMode`）。
 *
 * 注册在 `JwtAuthGuard` 之后，因此已登录请求上能拿到 `request.user`：
 * 平台超管始终放行，豁免路径与 `@SkipMaintenance()` 标注的路由不受影响，
 * 其余请求返回 503（带 `Retry-After`）。
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
    private readonly logger = new Logger(MaintenanceGuard.name);

    constructor(
        private readonly reflector: Reflector,
        private readonly settingsService: SettingsService,
        @Optional() private readonly configService?: ConfigService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        // Health and other explicit exemptions must never wait on settings/DB.
        const skip = this.reflector.getAllAndOverride<boolean>(
            SKIP_MAINTENANCE_KEY,
            [context.getHandler(), context.getClass()],
        );
        if (skip) return true;
        const request = context.switchToHttp().getRequest<Request>();
        if (
            isExemptPath(
                request.path,
                this.configService?.get<string>('app.globalPrefix') ?? '/api',
            )
        )
            return true;
        const user = request['user'] as { globalRole?: GlobalRole } | undefined;
        if (user?.globalRole === GlobalRole.SUPER_ADMIN) return true;
        let maintenance: boolean;
        try {
            maintenance = await this.settingsService.getBoolean(
                'system.maintenanceMode',
                false,
            );
        } catch (error) {
            // 读不到配置就放行：宁可漏拦，也不能让配置库抖动把整站变成 503
            this.logger.warn(
                `Failed to read system.maintenanceMode, allowing the request: ${String(error)}`,
            );
            return true;
        }
        if (!maintenance) return true;

        const response = context.switchToHttp().getResponse<Response>();
        response.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));

        throw new ServiceUnavailableException('系统维护中，请稍后再试。');
    }
}
