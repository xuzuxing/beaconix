/**
 * 支付宝异步通知验签调试脚本。
 *
 * 用 `docs/alipay-sanbox.md` 里的沙箱「支付宝公钥」验证一条回调 JSON 的
 * `sign` 是否合法，并给出诊断（sign 里的 `+`/`/` 是否被破坏、双重 decode 等）。
 *
 * 用法（任选其一）：
 *   pnpm exec tsx scripts/verify-alipay-notify.ts '<回调 JSON 字符串>'
 *   pnpm exec tsx scripts/verify-alipay-notify.ts notify.json
 *   cat notify.json | pnpm exec tsx scripts/verify-alipay-notify.ts -
 *
 * 输出的「回调 JSON」里，`sign` 是支付宝签名的 base64（RSA2），其它字段是
 * 已 decode 的原始值（`subject` 是空格、`sign` 里的 `+`/`/` 保持原样）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { AlipaySdk } from 'alipay-sdk';

const SANDBOX_MD = 'docs/alipay-sanbox.md';

function readSandboxConfig(): {
    appId: string;
    appPublicKey: string;
    alipayPublicKey: string;
} {
    if (!existsSync(SANDBOX_MD)) {
        throw new Error(`找不到 ${SANDBOX_MD}：请先在该文件里填入沙箱密钥`);
    }

    const md = readFileSync(SANDBOX_MD, 'utf8');
    const appPublicKeyMatch = md.match(/应用公钥[:：]\s*([A-Za-z0-9+/=]+)/);
    const alipayPublicKeyMatch = md.match(
        /支付宝公钥[:：]\s*([A-Za-z0-9+/=]+)/,
    );

    if (!alipayPublicKeyMatch) {
        throw new Error(
            `${SANDBOX_MD} 里找不到「支付宝公钥」行（注意：不是「应用公钥」）`,
        );
    }

    const appIdMatch = md.match(/APPID[:：]\s*(\d+)/);

    return {
        appId: appIdMatch?.[1] ?? '',
        appPublicKey: appPublicKeyMatch?.[1] ?? '',
        alipayPublicKey: alipayPublicKeyMatch[1],
    };
}

function toPem(publicKey: string): string {
    return `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;
}

/** 从命令行参数 / 文件 / stdin 读取回调 JSON。 */
function readCallbackJson(): Record<string, string> {
    const input = process.argv[2];
    let raw: string;

    if (!input || input === '-') {
        raw = readFileSync(0, 'utf8');
    } else if (existsSync(input)) {
        raw = readFileSync(input, 'utf8');
    } else {
        raw = input;
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const params: Record<string, string> = {};

    for (const [key, value] of Object.entries(parsed)) {
        params[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }

    return params;
}

function main(): void {
    const config = readSandboxConfig();
    const params = readCallbackJson();
    const sign = params['sign'];

    console.log(`appId     ${config.appId || '(未在 md 里找到 APPID)'}`);
    console.log(`out_trade_no  ${params['out_trade_no'] ?? '(缺失)'}`);
    console.log(`trade_status  ${params['trade_status'] ?? '(缺失)'}`);
    console.log(
        `sign       ${sign ? `含 ${(sign.match(/\+/g) ?? []).length} 个 +，${(sign.match(/\//g) ?? []).length} 个 /` : '(缺失)'}`,
    );
    console.log('');

    const alipaySdk = new AlipaySdk({
        appId: config.appId || 'unused',
        privateKey: 'unused',
        alipayPublicKey: toPem(config.alipayPublicKey),
        signType: 'RSA2',
        keyType: 'PKCS8',
    });

    const appSdk = config.appPublicKey
        ? new AlipaySdk({
              appId: config.appId || 'unused',
              privateKey: 'unused',
              alipayPublicKey: toPem(config.appPublicKey),
              signType: 'RSA2',
              keyType: 'PKCS8',
          })
        : null;

    const v2 = alipaySdk.checkNotifySignV2(params);
    const v1 = alipaySdk.checkNotifySign(params);

    console.log('—— 用「支付宝公钥」验签（验签回调就该用这个）——');
    console.log(
        `  checkNotifySignV2（修复后，不二次 decode）: ${v2 ? '✅ 通过' : '❌ 失败'}`,
    );
    console.log(
        `  checkNotifySign  （旧方法，会 decodeURIComponent）: ${v1 ? '✅ 通过' : '❌ 失败'}`,
    );

    if (appSdk) {
        const appResult = appSdk.checkNotifySignV2(params);
        console.log('');
        console.log(
            '—— 用「应用公钥」验签（仅对照，不该填到 alipay.publicKey）——',
        );
        console.log(
            `  checkNotifySignV2: ${appResult ? '✅ 通过' : '❌ 失败'}`,
        );
        if (!appResult && v2) {
            console.log(
                '  ⚠️  应用公钥验签失败、支付宝公钥验签通过 → 线上 alipay.publicKey 如果填的是「应用公钥」，就会一直 failure。',
            );
        }
    }

    if (v2 && v1) {
        console.log(
            '\n结论：这条通知的 sign 合法，用沙箱「支付宝公钥」验签能过。',
        );
        console.log(
            '如果线上回调仍回 failure，检查线上 settings 里 alipay.publicKey 是否等于 md 里的「支付宝公钥」（别填成「应用公钥」）、alipay.sandbox=true、alipay.mock=false，且线上已部署最新代码。',
        );
        return;
    }

    // 失败诊断：最常见的坑是 sign 里的 + 被 form 解析当空格。
    if (!v2 && sign) {
        const mangled = { ...params, sign: sign.replace(/\+/g, ' ') };
        const mangledResult = alipaySdk.checkNotifySignV2(mangled);

        console.log('\n诊断：');
        console.log(
            `  把 sign 里的 + 换成空格后验签: ${mangledResult ? '✅ 通过（说明你的 sign 里的 + 已被破坏成空格）' : '❌ 仍失败（不是 + 的问题）'}`,
        );
    }

    console.log(
        '\n结论：验签失败。最常见原因：① alipay.publicKey 填错（应为沙箱「支付宝公钥」）；② sign 被 body-parser/URLSearchParams 把 + 当空格破坏了（应走 rawBody + decodeURIComponent）。',
    );
}

try {
    main();
} catch (error) {
    console.error(
        `❌ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
}
