/**
 * 本地联调：手工构造并投递支付渠道的「异步通知 / 推送」，在没有真实商户凭证
 * （`ALIPAY_MOCK` / `WECHAT_MOCK` / 虚拟支付 mock 打开）的情况下把
 * 「支付 → 结算 → 订阅激活」整条链路跑通。
 *
 * 用法：
 *   pnpm mock:pay alipay    --order-no BW123          # 支付宝异步通知
 *   pnpm mock:pay wechat    --order-no BW123          # 微信支付 V3 交易回调（JSAPI）
 *   pnpm mock:pay wechat-virtual --out-trade-no V123  # 小程序虚拟支付：发货推送
 *   pnpm mock:pay wechat-virtual-refund --out-trade-no V123
 *   pnpm mock:pay wechat-refund --refund-no RF123     # 微信 V3 退款结果通知
 *
 * 省略定位参数时，脚本会直接从数据库取「最近一条待支付记录」，金额也从库里
 * 读——虚拟支付的推送金额必须与下单金额一致，手抄极易抄错。
 * 各通道的前置条件见 `printUsage()`。
 *
 * 注意：只有渠道处于 mock 模式时才能这样伪造——真实模式下支付宝验签、微信
 * 解密都会被拒绝（`ALIPAY_MOCK=false` 时通知会被判 `NOTIFY_SIGN_INVALID`）。
 */

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../src/generated/prisma/client';
import type { Prisma } from '../src/generated/prisma/client';
import {
    OrderStatus,
    PaymentAttemptStatus,
    PaymentChannel,
    RefundStatus,
} from '../src/generated/prisma/enums';

const CHANNELS = [
    'alipay',
    'wechat',
    'wechat-virtual',
    'wechat-refund',
    'wechat-virtual-refund',
] as const;

type Channel = (typeof CHANNELS)[number];

type ContentType =
    | 'application/json'
    | 'application/x-www-form-urlencoded'
    | 'text/xml';

interface Options {
    baseUrl: string;
    orderId?: string;
    orderNo?: string;
    outTradeNo?: string;
    refundNo?: string;
    /** 金额（分）。省略时从数据库读。 */
    amount?: number;
    /** 渠道单号：支付宝 `trade_no` / 微信 `transaction_id` / 虚拟支付 `MchOrderNo`。 */
    tradeNo?: string;
    openid?: string;
    appId?: string;
    useDb: boolean;
    dryRun: boolean;
    format: 'json' | 'xml';
}

/** 一条待投递的回调。 */
interface CallbackRequest {
    channel: Channel;
    path: string;
    contentType: ContentType;
    body: string;
    /** 这条报文在模拟什么。 */
    scenario: string;
    /** 成功处理后应当成立的事实。 */
    expectation: string;
    orderId?: string;
    orderNo?: string;
    outTradeNo?: string;
}

type Db = PrismaClient;

function main(): void {
    run().catch((error: unknown) => {
        // 参数/前置条件错误只需一行结论，堆栈对使用者没有价值。
        console.error(
            `❌ ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
    });
}

async function run(): Promise<void> {
    const { positional, flags } = parseArgv(process.argv.slice(2));
    const channel = positional[0];

    if (hasFlag(flags, 'help')) {
        printUsage();
        return;
    }

    if (!channel || !isChannel(channel)) {
        if (channel) console.error(`未知通道：${channel}`);
        printUsage();
        process.exitCode = 1;
        return;
    }

    const options = readOptions(flags);
    const db = options.useDb ? openDb() : null;

    try {
        const request = await buildRequest(channel, options, db?.prisma ?? null);

        await deliver(request, options, db?.prisma ?? null);
    } finally {
        await db?.close();
    }
}

// -- 报文构造 -------------------------------------------------------------

async function buildRequest(
    channel: Channel,
    options: Options,
    db: Db | null,
): Promise<CallbackRequest> {
    switch (channel) {
        case 'alipay':
            return buildAlipayRequest(options, db);
        case 'wechat':
            return buildWechatRequest(options, db);
        case 'wechat-virtual':
            return buildVirtualDeliverRequest(options, db);
        case 'wechat-virtual-refund':
            return buildVirtualRefundRequest(options, db);
        case 'wechat-refund':
            return buildWechatRefundRequest(options, db);
    }
}

/**
 * 支付宝异步通知。
 *
 * mock 下 `AlipayPaymentService.verifyCallback` 跳过验签与 app_id 校验，只要求
 * `out_trade_no` 存在、`trade_status` ∈ `TRADE_SUCCESS` / `TRADE_FINISHED`。
 * 应答是**纯文本** `success` / `failure`。
 */
async function buildAlipayRequest(
    options: Options,
    db: Db | null,
): Promise<CallbackRequest> {
    const order = await findOrder(db, options, PaymentChannel.ALIPAY);
    const orderNo = options.orderNo ?? order?.orderNo;

    if (!orderNo) {
        throw new Error(
            '找不到可用于回调的订单：用 --order-no 指定订单号，或先执行 ' +
                'POST /api/orders/:id/pay {"channel":"ALIPAY"} 生成支付记录',
        );
    }

    if (order && order.payment?.channel !== PaymentChannel.ALIPAY) {
        warn(
            `订单 ${orderNo} 没有 ALIPAY 支付记录，回调会被判 "Payment not found"；` +
                '先调用 POST /api/orders/:id/pay',
        );
    }

    const amount = options.amount ?? order?.amount;
    const params = new URLSearchParams();

    params.set('out_trade_no', orderNo);
    params.set('trade_no', options.tradeNo ?? `mock_trade_${orderNo}`);
    params.set('trade_status', 'TRADE_SUCCESS');
    params.set('sign', 'mock-signature');
    params.set('sign_type', 'RSA2');

    if (options.appId) params.set('app_id', options.appId);
    if (amount !== undefined) params.set('total_amount', yuanFromFen(amount));

    return {
        channel: 'alipay',
        path: '/api/payment/alipay/callback',
        contentType: 'application/x-www-form-urlencoded',
        body: params.toString(),
        scenario: `支付宝异步通知 TRADE_SUCCESS（订单 ${orderNo}${
            amount === undefined ? '' : `，${yuanFromFen(amount)} 元`
        }）`,
        expectation: '应答纯文本 success；订单变 PAID、订阅激活',
        orderId: order?.id,
        orderNo,
    };
}

/**
 * 微信支付 V3 交易回调（JSAPI）。
 *
 * mock 下 `WechatPaymentService.verifyCallback` 直接 `JSON.parse` 原始报文，
 * 所以字段是**平铺**的（真实报文里它们在加密的 `resource` 内）。
 * 应答是裸 JSON `{ code: "SUCCESS", message: "成功" }`，失败返回 400 + FAIL。
 */
async function buildWechatRequest(
    options: Options,
    db: Db | null,
): Promise<CallbackRequest> {
    const order = await findOrder(db, options, PaymentChannel.WECHAT);
    const orderNo = options.orderNo ?? order?.orderNo;

    if (!orderNo) {
        throw new Error(
            '找不到可用于回调的订单：用 --order-no 指定订单号，或先执行 ' +
                'POST /api/orders/:id/pay {"channel":"WECHAT","openid":"..."} 生成支付记录',
        );
    }

    if (order && order.payment?.channel !== PaymentChannel.WECHAT) {
        warn(
            `订单 ${orderNo} 没有 WECHAT(JSAPI) 支付记录，回调会被判 "Payment not found"；` +
                '先调用 POST /api/orders/:id/pay',
        );
    }

    const amount = options.amount ?? order?.amount;
    const payload = {
        id: `mock-notify-${Date.now()}`,
        event_type: 'TRANSACTION.SUCCESS',
        resource_type: 'encrypt-resource',
        summary: '支付成功',
        // ↓ mock 分支直接读这几个字段
        out_trade_no: orderNo,
        transaction_id: options.tradeNo ?? `mock_txn_${orderNo}`,
        trade_state: 'SUCCESS',
        trade_status: 'SUCCESS',
        success_time: new Date().toISOString(),
        appid: options.appId,
        amount:
            amount === undefined
                ? undefined
                : { total: amount, payer_total: amount, currency: 'CNY' },
    };

    return {
        channel: 'wechat',
        path: '/api/payment/wechat/callback',
        contentType: 'application/json',
        body: JSON.stringify(payload),
        scenario: `微信支付 V3 交易回调 SUCCESS（订单 ${orderNo}）`,
        expectation: '应答 {"code":"SUCCESS"}；订单变 PAID、订阅激活',
        orderId: order?.id,
        orderNo,
    };
}

/**
 * 小程序虚拟支付：发货推送 `xpay_goods_deliver_notify`。
 *
 * 与 JSAPI 回调完全不同的通道，别混用：
 * - 幂等键是 `WeChatPayInfo.MchOrderNo`（= `wx_order_id`），不是 `out_trade_no`；
 * - 必须存在 `PaymentAttempt`（虚拟支付下单时写入的「尝试」记录），推送里的
 *   `OutTradeNo` 是那次尝试的商家单号，**不是** `Order.orderNo`；
 * - `GoodsInfo.ActualPrice` 必须与 `PaymentAttempt.amount` 完全一致，否则会被
 *   判 `amount mismatch`；
 * - mock 下 `query_order` 反查被跳过，应答是 `{"ErrCode":0,"ErrMsg":"success"}`。
 */
async function buildVirtualDeliverRequest(
    options: Options,
    db: Db | null,
): Promise<CallbackRequest> {
    const attempt = await findAttempt(db, options);
    const outTradeNo = options.outTradeNo ?? attempt?.outTradeNo;

    if (!outTradeNo) {
        throw new Error(
            '找不到虚拟支付的 PaymentAttempt：虚拟支付下单必须用小程序 wx.login() 的 code，' +
                '脚本无法代劳。先在小程序里下单，或用 --out-trade-no 指定商家单号',
        );
    }

    const amount = options.amount ?? attempt?.amount;

    if (amount === undefined) {
        throw new Error(
            '缺少金额：推送里的 ActualPrice（分）必须与下单金额一致，' +
                '请连接数据库或显式传 --amount',
        );
    }

    if (attempt && amount !== attempt.amount) {
        warn(
            `--amount ${amount} 与下单金额 ${attempt.amount} 不一致，将被判 amount mismatch（测异常分支时才有意为之）`,
        );
    }

    const payload = {
        Event: 'xpay_goods_deliver_notify',
        OpenId: options.openid ?? attempt?.openid ?? 'mock_openid',
        OutTradeNo: outTradeNo,
        Env: attempt?.env ?? 0,
        WeChatPayInfo: {
            MchOrderNo: options.tradeNo ?? `mock_wx_order_${outTradeNo}`,
            TransactionId: `mock_transaction_${outTradeNo}`,
            PaidTime: Math.floor(Date.now() / 1000),
        },
        GoodsInfo: {
            ProductId: attempt?.productId ?? 'mock_product',
            Quantity: 1,
            OrigPrice: amount,
            ActualPrice: amount,
        },
    };

    return {
        channel: 'wechat-virtual',
        path: '/api/payment/wechat-virtual/notify',
        contentType: options.format === 'xml' ? 'text/xml' : 'application/json',
        body: serialize(payload, options.format),
        scenario: `虚拟支付发货推送（商家单号 ${outTradeNo}，${amount} 分）`,
        expectation:
            '应答 {"ErrCode":0}；PaymentAttempt 变 PAID、订单变 PAID、订阅激活',
        orderId: attempt?.orderId,
        orderNo: attempt?.order.orderNo,
        outTradeNo,
    };
}

/**
 * 小程序虚拟支付：退款推送 `xpay_refund_notify`。
 *
 * 有在途退款申请（后台或用户发起）时走统一结算；没有的话按「Apple 侧发起
 * 的退款」补一条被动退款记录。订阅回收只在统一结算路径发生。
 */
async function buildVirtualRefundRequest(
    options: Options,
    db: Db | null,
): Promise<CallbackRequest> {
    const attempt = await findAttempt(db, options);
    const outTradeNo = options.outTradeNo ?? attempt?.outTradeNo;

    if (!outTradeNo) {
        throw new Error(
            '找不到虚拟支付的 PaymentAttempt：用 --out-trade-no 指定商家单号',
        );
    }

    const amount = options.amount ?? attempt?.amount ?? 1;
    const refundId = options.tradeNo ?? `mock_refund_${outTradeNo}`;
    const payload = {
        Event: 'xpay_refund_notify',
        OpenId: options.openid ?? attempt?.openid ?? 'mock_openid',
        OutTradeNo: outTradeNo,
        Env: attempt?.env ?? 0,
        RefundInfo: {
            MchOrderNo: attempt?.wxOrderId ?? `mock_wx_order_${outTradeNo}`,
            WxOrderId: attempt?.wxOrderId ?? `mock_wx_order_${outTradeNo}`,
            RefundId: refundId,
            RefundFee: amount,
            OrderFee: amount,
            RefundTime: Math.floor(Date.now() / 1000),
        },
    };

    return {
        channel: 'wechat-virtual-refund',
        path: '/api/payment/wechat-virtual/notify',
        contentType: options.format === 'xml' ? 'text/xml' : 'application/json',
        body: serialize(payload, options.format),
        scenario: `虚拟支付退款推送（商家单号 ${outTradeNo}，${amount} 分）`,
        expectation:
            '应答 {"ErrCode":0}；有在途退款则结算该退款，否则补一条被动退款记录',
        orderId: attempt?.orderId,
        orderNo: attempt?.order.orderNo,
        outTradeNo,
    };
}

/**
 * 微信支付 V3 退款结果通知。
 *
 * mock 下 `parseRefundCallback` 直接读 JSON，只认 `out_refund_no` /
 * `refund_id` / `refund_status`；本地必须有对应 `Refund` 记录（先发起退款）。
 */
async function buildWechatRefundRequest(
    options: Options,
    db: Db | null,
): Promise<CallbackRequest> {
    const refund = await findRefund(db, options);
    const refundNo = options.refundNo ?? refund?.refundNo;

    if (!refundNo) {
        throw new Error(
            '找不到退款单：用 --refund-no 指定退款单号，或先在后台/用户侧发起退款',
        );
    }

    const payload = {
        id: `mock-refund-notify-${Date.now()}`,
        event_type: 'REFUND.SUCCESS',
        resource_type: 'encrypt-resource',
        summary: '退款成功',
        // ↓ mock 分支直接读这三个字段
        out_refund_no: refundNo,
        refund_id: options.tradeNo ?? `mock_refund_${refundNo}`,
        refund_status: 'SUCCESS',
    };

    return {
        channel: 'wechat-refund',
        path: '/api/payment/wechat-refund-callback',
        contentType: 'application/json',
        body: JSON.stringify(payload),
        scenario: `微信 V3 退款结果通知 REFUND.SUCCESS（退款单 ${refundNo}）`,
        expectation: '应答 {"code":"SUCCESS"}；退款单变 SUCCESS、订阅按策略回收',
        orderId: refund?.orderId,
    };
}

// -- 数据库查询 -----------------------------------------------------------

/** 按 orderId / orderNo 定位订单；都没有时取「最近一条该通道的待支付订单」。 */
async function findOrder(
    db: Db | null,
    options: Options,
    channel: PaymentChannel,
) {
    if (!db) return null;

    if (options.orderId) {
        return db.order.findUnique({
            where: { id: options.orderId },
            include: { payment: true },
        });
    }

    if (options.orderNo) {
        return db.order.findFirst({
            where: { orderNo: options.orderNo },
            include: { payment: true },
        });
    }

    return db.order.findFirst({
        where: { status: OrderStatus.PENDING, payment: { channel } },
        include: { payment: true },
        orderBy: { createdAt: 'desc' },
    });
}

/** 定位虚拟支付的 PaymentAttempt：优先待支付，其次任意最近一条。 */
async function findAttempt(db: Db | null, options: Options) {
    if (!db) return null;

    const where: Prisma.PaymentAttemptWhereInput = options.outTradeNo
        ? { outTradeNo: options.outTradeNo }
        : options.orderNo
          ? { order: { orderNo: options.orderNo } }
          : options.orderId
            ? { orderId: options.orderId }
            : { channel: PaymentChannel.WECHAT_VIRTUAL };

    const pending = await db.paymentAttempt.findFirst({
        where: { ...where, status: PaymentAttemptStatus.PENDING },
        include: { order: true },
        orderBy: { createdAt: 'desc' },
    });

    if (pending) return pending;

    return db.paymentAttempt.findFirst({
        where,
        include: { order: true },
        orderBy: { createdAt: 'desc' },
    });
}

/** 定位退款单：优先在途（PENDING / PROCESSING），其次任意最近一条。 */
async function findRefund(db: Db | null, options: Options) {
    if (!db) return null;

    if (options.refundNo) {
        return db.refund.findUnique({ where: { refundNo: options.refundNo } });
    }

    const where: Prisma.RefundWhereInput = options.orderId
        ? { orderId: options.orderId }
        : {};

    const inFlight = await db.refund.findFirst({
        where: {
            ...where,
            status: { in: [RefundStatus.PENDING, RefundStatus.PROCESSING] },
        },
        orderBy: { createdAt: 'desc' },
    });

    if (inFlight) return inFlight;

    return db.refund.findFirst({ where, orderBy: { createdAt: 'desc' } });
}

// -- 投递与结果 -----------------------------------------------------------

async function deliver(
    request: CallbackRequest,
    options: Options,
    db: Db | null,
): Promise<void> {
    const url = `${options.baseUrl.replace(/\/+$/, '')}${request.path}`;

    log(`通道     ${channelLabel(request.channel)}`);
    log(`场景     ${request.scenario}`);
    log(`POST     ${url}`);
    log(`报文     ${request.body}`);

    if (options.dryRun) {
        log('--dry-run：只打印报文，未发送');
        log(`预期     ${request.expectation}`);
        return;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': request.contentType },
        body: request.body,
    });
    const text = await response.text();

    log(`HTTP     ${response.status}`);
    log(`应答     ${text.trim()}`);
    log(`预期     ${request.expectation}`);
    log(`结论     ${verdict(request.channel, response.status, text)}`);

    await reportOutcome(db, request);

    log('提示     再跑一次同样的命令可以验证幂等（重复通知应仍然返回成功）');
}

/** 把渠道应答翻译成一句人话。 */
function verdict(channel: Channel, status: number, text: string): string {
    if (channel === 'alipay') {
        return text.trim() === 'success'
            ? '✅ 服务端已确认这笔支付宝通知'
            : '⚠️ 服务端回了 failure：看接口控制台里的 WARN 行（带 NOTIFY_* 原因码）';
    }

    // 微信两种回调都是 `{ code: "SUCCESS" | "FAIL", message }`
    if (channel === 'wechat' || channel === 'wechat-refund') {
        const code = readJsonField(text, 'code');
        const what =
            channel === 'wechat' ? '这笔微信支付回调' : '这笔微信退款通知';

        return code === 'SUCCESS'
            ? `✅ 服务端已确认${what}`
            : `⚠️ 服务端回了 ${code ?? '无法解析的应答'}（HTTP ${status}），原因见控制台`;
    }

    // 虚拟支付推送走 `{ ErrCode: 0, ErrMsg }`，0 = 不用重试
    const errCode = readJsonField(text, 'ErrCode');

    return errCode === '0'
        ? '✅ 服务端已处理这条虚拟支付推送'
        : `⚠️ 服务端回了 ErrCode=${errCode ?? '?'}，原因见控制台日志`;
}

/** 发送后直接回查数据库，省得再开一个客户端确认结果。 */
async function reportOutcome(
    db: Db | null,
    request: CallbackRequest,
): Promise<void> {
    if (!db) return;

    if (request.outTradeNo) {
        const attempt = await db.paymentAttempt.findUnique({
            where: { outTradeNo: request.outTradeNo },
            select: { status: true, wxOrderId: true, amount: true },
        });

        if (attempt) {
            log(
                `库内     PaymentAttempt ${attempt.status}（wxOrderId ${attempt.wxOrderId ?? '—'}，${attempt.amount} 分）`,
            );
        }
    }

    if (!request.orderId) return;

    const order = await db.order.findUnique({
        where: { id: request.orderId },
        select: {
            orderNo: true,
            status: true,
            paidAt: true,
            serviceStartsAt: true,
            serviceEndsAt: true,
        },
    });

    if (!order) return;

    log(
        `库内     Order ${order.orderNo} → ${order.status}` +
            (order.paidAt ? `，paidAt ${order.paidAt.toISOString()}` : '') +
            (order.serviceStartsAt && order.serviceEndsAt
                ? `，服务期 ${order.serviceStartsAt.toISOString()} → ${order.serviceEndsAt.toISOString()}`
                : ''),
    );
}

// -- 数据库连接 -----------------------------------------------------------

function openDb(): { prisma: Db; close: () => Promise<void> } {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
        throw new Error(
            'DATABASE_URL 未设置：无法自动读取金额/单号。加 --no-db 并显式传 --order-no、--amount',
        );
    }

    const pool = new Pool({ connectionString });
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    return {
        prisma,
        close: async () => {
            await prisma.$disconnect();
            await pool.end();
        },
    };
}

// -- 参数 ---------------------------------------------------------------

function parseArgv(argv: string[]): {
    positional: string[];
    flags: Map<string, string | true>;
} {
    const positional: string[] = [];
    const flags = new Map<string, string | true>();

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];

        if (!token.startsWith('--')) {
            positional.push(token);
            continue;
        }

        const [name, inline] = token.slice(2).split('=');

        if (inline !== undefined) {
            flags.set(name, inline);
            continue;
        }

        const next = argv[i + 1];

        if (next !== undefined && !next.startsWith('--')) {
            flags.set(name, next);
            i += 1;
            continue;
        }

        flags.set(name, true);
    }

    return { positional, flags };
}

function readOptions(flags: Map<string, string | true>): Options {
    return {
        baseUrl:
            text(flags, 'base-url') ??
            process.env.MOCK_PAY_BASE_URL ??
            'http://localhost:3000',
        orderId: text(flags, 'order-id'),
        orderNo: text(flags, 'order-no'),
        outTradeNo: text(flags, 'out-trade-no'),
        refundNo: text(flags, 'refund-no'),
        amount: numberFlag(flags, 'amount'),
        tradeNo: text(flags, 'trade-no'),
        openid: text(flags, 'openid'),
        appId: text(flags, 'app-id'),
        useDb: !bool(flags, 'no-db'),
        dryRun: bool(flags, 'dry-run'),
        format: bool(flags, 'xml') ? 'xml' : 'json',
    };
}

function text(
    flags: Map<string, string | true>,
    name: string,
): string | undefined {
    const value = flags.get(name);

    return typeof value === 'string' ? value : undefined;
}

function bool(flags: Map<string, string | true>, name: string): boolean {
    const value = flags.get(name);

    if (value === undefined) return false;

    return value === true || value !== 'false';
}

function numberFlag(
    flags: Map<string, string | true>,
    name: string,
): number | undefined {
    const raw = text(flags, name);

    if (raw === undefined) return undefined;

    const parsed = Number(raw);

    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`--${name} 必须是非负整数（分），收到 "${raw}"`);
    }

    return parsed;
}

function hasFlag(flags: Map<string, string | true>, name: string): boolean {
    return flags.has(name);
}

// -- 工具 ---------------------------------------------------------------

function isChannel(value: string): value is Channel {
    return (CHANNELS as readonly string[]).includes(value);
}

/** 分 → 元的两位小数字符串（与 `AlipayPaymentService` 的换算一致）。 */
function yuanFromFen(fen: number): string {
    const yuan = Math.floor(fen / 100);
    const cents = fen % 100;

    return `${yuan}.${String(cents).padStart(2, '0')}`;
}

/** 虚拟支付推送可选 XML（MP 后台【数据格式】选 XML 时）。 */
function serialize(payload: Record<string, unknown>, format: 'json' | 'xml') {
    return format === 'xml' ? toXml(payload) : JSON.stringify(payload);
}

function toXml(root: Record<string, unknown>): string {
    const body = Object.entries(root)
        .map(([key, value]) => {
            if (value !== null && typeof value === 'object') {
                const inner = Object.entries(value as Record<string, unknown>)
                    .map(([childKey, childValue]) => {
                        return `<${childKey}>${escapeXml(childValue)}</${childKey}>`;
                    })
                    .join('');

                return `<${key}>${inner}</${key}>`;
            }

            return `<${key}>${escapeXml(value)}</${key}>`;
        })
        .join('');

    return `<xml>${body}</xml>`;
}

function escapeXml(value: unknown): string {
    if (value === null || value === undefined) return '';

    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function readJsonField(text: string, field: string): string | undefined {
    try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const value = parsed[field];

        return value === undefined || value === null ? undefined : String(value);
    } catch {
        return undefined;
    }
}

function channelLabel(channel: Channel): string {
    switch (channel) {
        case 'alipay':
            return '支付宝（异步通知）';
        case 'wechat':
            return '微信支付 V3（JSAPI 交易回调）';
        case 'wechat-virtual':
            return '小程序虚拟支付（发货推送）';
        case 'wechat-virtual-refund':
            return '小程序虚拟支付（退款推送）';
        case 'wechat-refund':
            return '微信支付 V3（退款结果通知）';
    }
}

function log(message: string): void {
    console.log(message);
}

function warn(message: string): void {
    console.warn(`⚠️  ${message}`);
}

function printUsage(): void {
    console.log(
        `
本地联调：投递支付渠道回调/推送（仅 mock 模式可用）

用法
  pnpm mock:pay <channel> [flags]

channel
  alipay                 支付宝异步通知            POST /api/payment/alipay/callback
  wechat                 微信 V3 交易回调（JSAPI） POST /api/payment/wechat/callback
  wechat-virtual         虚拟支付·发货推送         POST /api/payment/wechat-virtual/notify
  wechat-virtual-refund  虚拟支付·退款推送         POST /api/payment/wechat-virtual/notify
  wechat-refund          微信 V3 退款结果通知      POST /api/payment/wechat-refund-callback

flags
  --order-no <BW...>       订单号（支付宝/微信；省略则取最近一条待支付订单）
  --order-id <cuid>        订单 id
  --out-trade-no <V...>    虚拟支付的商家单号（PaymentAttempt.outTradeNo）
  --refund-no <RF...>      退款单号（省略则取最近一条在途退款）
  --amount <分>            覆盖金额；虚拟支付必须与下单金额一致，否则判 amount mismatch
  --trade-no <string>      渠道单号（支付宝 trade_no / 微信 transaction_id / MchOrderNo）
  --openid <string>        虚拟支付推送里的 OpenId
  --app-id <string>        支付宝通知里的 app_id（mock 不校验）
  --base-url <url>         服务地址，默认 http://localhost:3000（或 MOCK_PAY_BASE_URL）
  --xml                    虚拟支付推送改用 XML（默认 JSON）
  --no-db                  不连数据库（需自行提供 --order-no / --amount）
  --dry-run                只打印报文，不发请求
  --help                   显示本说明

前置条件（缺一步回调都会被判失败）
  alipay / wechat   订单存在，且已调 POST /api/orders/:id/pay 生成对应通道的 Payment 记录
  wechat-virtual    存在 PaymentAttempt（虚拟支付下单必须用小程序 wx.login() 的 code）
  wechat-refund     存在 Refund 记录（先在后台或用户侧发起退款）
  所有通道          ALIPAY_MOCK / WECHAT_MOCK / 虚拟支付 mock 为 true

示例
  pnpm mock:pay alipay --order-no BW20261022001
  pnpm mock:pay wechat --order-no BW20261022001
  pnpm mock:pay wechat-virtual                 # 自动取最近一条待支付尝试
  pnpm mock:pay wechat-virtual-refund --out-trade-no V20261022001
  pnpm mock:pay alipay --order-no BW1 --amount 2900 --no-db --dry-run
`.trim(),
    );
}

void main();
