import { Injectable } from '@nestjs/common';
import { SettingsService } from '../../settings';
import {
    DEFAULT_REFUND_POLICY,
    type RefundPolicyConfig,
} from './refund-policy';

/**
 * 退款相关的运行时配置。
 *
 * 全部来自管理页（`billing.refund.*`），没有 env 兜底——这些是业务策略而不是
 * 部署差异，默认值就写在代码里。`SettingsService` 已按 key 缓存 30 秒，所以
 * 后台改完最多 30 秒生效；紧急止血就是把 `billing.refund.enabled` 关掉。
 */
export interface RefundRuntimeConfig extends RefundPolicyConfig {
    /** 总开关。默认关闭：迁移与代码先上线，再由运营手动打开。 */
    enabled: boolean;
    /** P1：是否允许用户自助申请（关闭时只有后台能发起）。 */
    userSelfService: boolean;
    /** P1：小额自动通过阈值（分），0 表示全部人工审批。 */
    autoApproveLimit: number;
}

export const DEFAULT_REFUND_RUNTIME_CONFIG: RefundRuntimeConfig = {
    ...DEFAULT_REFUND_POLICY,
    enabled: false,
    userSelfService: false,
    autoApproveLimit: 0,
};

/** 手续费上限 30%：再高就不是退款而是罚款了。 */
const MAX_FEE_RATE = 0.3;

@Injectable()
export class RefundConfigService {
    constructor(private readonly settings: SettingsService) {}

    async config(): Promise<RefundRuntimeConfig> {
        const [
            enabled,
            coolingOffDays,
            prorate,
            feeRate,
            minAmount,
            userSelfService,
            autoApproveLimit,
        ] = await Promise.all([
            this.flag('billing.refund.enabled', false),
            this.integer('billing.refund.coolingOffDays', 7, 0, 365),
            this.flag('billing.refund.prorate', true),
            this.rate('billing.refund.feeRate', 0),
            this.integer('billing.refund.minAmount', 0, 0, 100_000_000),
            this.flag('billing.refund.userSelfService', false),
            this.integer('billing.refund.autoApproveLimit', 0, 0, 100_000_000),
        ]);

        return {
            enabled,
            coolingOffDays,
            prorate,
            feeRate,
            minAmount,
            userSelfService,
            autoApproveLimit,
        };
    }

    // -- 合并规则：只认管理页改过的值，否则用内置默认 ----------------------

    private async flag(key: string, fallback: boolean): Promise<boolean> {
        const value = await this.settings.getOverriddenValue(key);
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['1', 'true', 'yes'].includes(normalized)) return true;
            if (['0', 'false', 'no'].includes(normalized)) return false;
        }

        return fallback;
    }

    private async integer(
        key: string,
        fallback: number,
        min: number,
        max: number,
    ): Promise<number> {
        const value = await this.settings.getOverriddenValue(key);
        const parsed =
            typeof value === 'number'
                ? value
                : typeof value === 'string'
                  ? Number(value.trim())
                  : Number.NaN;

        if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
            return fallback;
        }

        return Math.min(max, Math.max(min, parsed));
    }

    /** 手续费率支持 5 与 0.05 两种写法（管理页容易填成百分数）。 */
    private async rate(key: string, fallback: number): Promise<number> {
        const value = await this.settings.getOverriddenValue(key);
        const parsed =
            typeof value === 'number'
                ? value
                : typeof value === 'string'
                  ? Number(value.trim())
                  : Number.NaN;

        if (!Number.isFinite(parsed) || parsed < 0) return fallback;

        const normalized = parsed > 1 ? parsed / 100 : parsed;

        return Math.min(MAX_FEE_RATE, normalized);
    }
}
