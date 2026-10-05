/**
 * Mini-program (小程序) API types.
 *
 * Docs: https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/
 */

export interface Code2SessionInput {
    appId: string;
    appSecret: string;
    /** `wx.login()` result. */
    code: string;
}

export interface Code2SessionResult {
    openid: string;
    unionid?: string;
    /** Session key used to decrypt user data (kept server-side only). */
    sessionKey: string;
}

/** One template field, e.g. `{ thing1: { value: '订单API' } }`. */
export interface SubscribeMessageFieldValue {
    value: string;
}

export type SubscribeMessageData = Record<string, SubscribeMessageFieldValue>;

export interface SendSubscribeMessageInput {
    appId: string;
    appSecret: string;
    openId: string;
    templateId: string;
    data: SubscribeMessageData;
    page?: string;
    /** Defaults to `formal`. */
    miniprogramState?: 'developer' | 'trial' | 'formal';
    /** Defaults to `zh_CN`. */
    lang?: string;
}

export interface SendSubscribeMessageBatchInput {
    appId: string;
    appSecret: string;
    openIds: string[];
    templateId: string;
    data: SubscribeMessageData;
    page?: string;
    miniprogramState?: 'developer' | 'trial' | 'formal';
    lang?: string;
}

export interface SendSubscribeMessageBatchResult {
    delivered: number;
    /** `openid: reason` entries for the recipients WeChat rejected. */
    failures: string[];
}

export interface GetPhoneNumberInput {
    appId: string;
    appSecret: string;
    /** `getPhoneNumber` result from the client. */
    code: string;
}

export interface WechatPhoneNumber {
    phoneNumber: string;
    purePhoneNumber: string;
    countryCode: string;
}
