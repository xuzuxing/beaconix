import { registerAs } from '@nestjs/config';
import { optionalEnv } from './env';

/** 支付宝签名算法：RSA2 = SHA256withRSA（新应用），RSA = SHA1withRSA（兼容旧应用）。 */
export type AlipaySignType = 'RSA2' | 'RSA';

export interface AlipayConfig {
    /** 开放平台应用的 APPID。 */
    appId: string;
    /** 应用私钥：PEM 全文，或服务器上的私钥文件路径。 */
    privateKey: string;
    /** 支付宝公钥（**不是**应用公钥）：PEM 全文，或文件路径。 */
    publicKey: string;
    /** 网关；`sandbox` 为 true 时由客户端改用沙箱网关，这里的值被忽略。 */
    gateway: string;
    signType: AlipaySignType;
    /** true 时走沙箱网关（仍会真实调用支付宝，与 `mock` 不同）。 */
    sandbox: boolean;
    /** 异步通知（notify_url）的公网地址。 */
    notifyUrl: string;
    /** 支付完成后浏览器跳回的地址（return_url），只用于体验，不能作为到账依据。 */
    returnUrl: string;
    /** true 时不调用真实接口，返回模拟支付参数，便于无凭证联调。 */
    mock: boolean;
}

export const ALIPAY_PRODUCTION_GATEWAY =
    'https://openapi.alipay.com/gateway.do';

/** 新版沙箱网关（旧版 `openapi.alipaydev.com` 已停止新应用接入）。 */
export const ALIPAY_SANDBOX_GATEWAY =
    'https://openapi-sandbox.dl.alipaydev.com/gateway.do';

function optionalFlag(key: string, fallback: boolean): boolean {
    return optionalEnv(key, String(fallback)) !== 'false';
}

function signType(key: string, fallback: AlipaySignType): AlipaySignType {
    const raw = optionalEnv(key, fallback).trim().toUpperCase();

    return raw === 'RSA' ? 'RSA' : 'RSA2';
}

/**
 * 支付宝开放平台的凭证与回调配置。
 *
 * 与微信一致：管理页（settings 表）里的 `alipay.*` 覆盖这里，留空回退环境变量。
 * 所有字段都有兜底，未接入支付宝的环境照样能启动。
 */
export const alipayConfig = registerAs('alipay', (): AlipayConfig => ({
    appId: optionalEnv('ALIPAY_APPID', ''),
    privateKey: optionalEnv('ALIPAY_PRIVATE_KEY', ''),
    publicKey: optionalEnv('ALIPAY_PUBLIC_KEY', ''),
    gateway: optionalEnv('ALIPAY_GATEWAY', ALIPAY_PRODUCTION_GATEWAY),
    signType: signType('ALIPAY_SIGN_TYPE', 'RSA2'),
    sandbox: optionalFlag('ALIPAY_SANDBOX', false),
    notifyUrl: optionalEnv('ALIPAY_NOTIFY_URL', ''),
    returnUrl: optionalEnv('ALIPAY_RETURN_URL', ''),
    mock: optionalFlag('ALIPAY_MOCK', true),
}));
