import { SetMetadata } from '@nestjs/common';

export const SKIP_MAINTENANCE_KEY = 'skipMaintenance';

/**
 * 维护模式（`system.maintenanceMode`）开启时仍然放行的路由。
 *
 * 标在控制器或方法上。放行的都是「维护期不能让系统彻底失联」的入口：
 * 登录/刷新 token（否则超管无法进去关开关）、健康检查、支付回调、
 * 探针上报、公开配置与公开状态页。
 *
 * 注意：漏标的路由在维护期会返回 503，新增对外入口时记得一起考虑。
 */
export const SkipMaintenance = () => SetMetadata(SKIP_MAINTENANCE_KEY, true);
