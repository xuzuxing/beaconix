/**
 * 虚拟支付推送的 JSON 解析与应答。
 *
 * 微信「消息推送」支持 XML / JSON 两种数据格式（MP 后台【开发管理 → 消息推送】
 * 里的「数据格式」），本项目统一走 JSON：字段路径与 XML 版完全一致
 * （`WeChatPayInfo.MchOrderNo`、`GoodsInfo.ActualPrice` …），只是没有 CDATA 与
 * 字符串化的数字，因此解析后的对象可以直接喂给 `parseDeliverNotify` /
 * `parseRefundNotify` 复用同一套字段提取逻辑。
 *
 * 应答要求：推送是 JSON 时，应答也必须是 JSON，否则微信会当作失败重试（最多 15 次）。
 */
export interface XpayJsonReply {
    ErrCode: number;
    ErrMsg: string;
}

/** 解析推送 JSON；非法报文抛错，由调用方转成失败应答。 */
export function parseXpayJson(body: string): Record<string, unknown> {
    let parsed: unknown;

    try {
        parsed = JSON.parse(body);
    } catch {
        throw new Error(
            'Unrecognised WeChat virtual payment payload (invalid JSON)',
        );
    }

    if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
    ) {
        throw new Error(
            'Unrecognised WeChat virtual payment payload (expected a JSON object)',
        );
    }

    return parsed as Record<string, unknown>;
}

/** 成功应答：`{"ErrCode":0,"ErrMsg":"success"}`。 */
export function buildXpayJsonSuccessReply(): string {
    const reply: XpayJsonReply = { ErrCode: 0, ErrMsg: 'success' };

    return JSON.stringify(reply);
}

/** 失败应答：平台据此重试。`ErrMsg` 里不要放密钥或用户隐私。 */
export function buildXpayJsonFailReply(errMsg: string): string {
    const reply: XpayJsonReply = {
        ErrCode: -1,
        ErrMsg: errMsg.slice(0, 120),
    };

    return JSON.stringify(reply);
}
