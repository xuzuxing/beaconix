import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { billingPaymentFixture } from './fixtures/billing-payment.fixture';
import { PrismaService } from '../src/infra/database/prisma.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { PaymentController } from '../src/modules/billing/payment/payment.controller';
import { PaymentService } from '../src/modules/billing/payment/payment.service';
import { WechatVirtualPaymentService } from '../src/modules/billing/payment/wechat-virtual-payment.service';
import { OrderController } from '../src/modules/billing/order/order.controller';
import { OrderService } from '../src/modules/billing/order/order.service';
import { RefundService } from '../src/modules/billing/refund/refund.service';

/** Real HTTP/controllers/guards/services with in-memory persistence and channel I/O. */
describe('Billing payment HTTP chain (offline)', () => {
    let app: INestApplication;
    let f: ReturnType<typeof billingPaymentFixture>;
    let token: string;
    beforeEach(async () => {
        f = billingPaymentFixture();
        const jwt = new JwtService({ secret: 'offline-payment-test-only' });
        token = jwt.sign({ sub: 'buyer' });
        const module = await Test.createTestingModule({
            controllers: [OrderController, PaymentController],
            providers: [
                { provide: PrismaService, useValue: f.prisma },
                { provide: OrderService, useValue: f.orders },
                { provide: PaymentService, useValue: f.payments },
                { provide: RefundService, useValue: f.refunds },
                { provide: WechatVirtualPaymentService, useValue: {} },
            ],
        }).compile();
        app = module.createNestApplication({ rawBody: true });
        app.setGlobalPrefix('api');
        app.useGlobalPipes(
            new ValidationPipe({
                whitelist: true,
                forbidNonWhitelisted: true,
                transform: true,
            }),
        );
        app.useGlobalGuards(new JwtAuthGuard(jwt, new Reflector(), f.prisma));
        app.useGlobalInterceptors(new TransformInterceptor());
        await app.init();
    });
    afterEach(() => Promise.resolve().then(() => app?.close()));

    async function buy() {
        const created = await request(app.getHttpServer())
            .post('/api/organizations/org/orders')
            .auth(token, { type: 'bearer' })
            .send({ planId: 'c123456789012345678901234' })
            .expect(201);
        const orderId = created.body.data.id;
        const payment = await request(app.getHttpServer())
            .post(`/api/orders/${orderId}/pay`)
            .auth(token, { type: 'bearer' })
            .send({ openid: 'openid' })
            .expect(200);
        return { orderId, merchant: payment.body.data.outTradeNo };
    }

    it('creates, settles, refunds and reconciles one order without repeating entitlement changes', async () => {
        const { orderId, merchant } = await buy();
        expect(merchant).toMatch(/^P[0-9a-f]{30}$/);
        const callback = f.paid(merchant);
        for (let repeat = 0; repeat < 2; repeat++) {
            const ack = await request(app.getHttpServer())
                .post('/api/payment/wechat/callback')
                .send(callback)
                .expect(200);
            expect(ack.body.code).toBe('SUCCESS');
            expect(ack.body.data).toBeUndefined();
        }
        expect(f.rows('subscription')).toHaveLength(1);
        const order = await request(app.getHttpServer())
            .get(`/api/orders/${orderId}`)
            .auth(token, { type: 'bearer' })
            .expect(200);
        expect(order.body.data.status).toBe('PAID');
        const refund = await request(app.getHttpServer())
            .post(`/api/orders/${orderId}/refunds`)
            .auth(token, { type: 'bearer' })
            .send({ reason: 'offline test' })
            .expect(200);
        expect(refund.body.data.status).toBe('PROCESSING');
        expect(f.provider.refund).toHaveBeenCalledWith(
            expect.objectContaining({ outTradeNo: merchant }),
        );
        await f.refunds.syncFromChannel(refund.body.data.id);
        await f.refunds.syncFromChannel(refund.body.data.id);
        expect(f.rows('order')[0]).toMatchObject({
            status: 'REFUNDED',
            refundedAmount: 2900,
        });
        expect(f.rows('subscription')[0].status).toBe('EXPIRED');
        expect(f.provider.queryRefund).toHaveBeenCalledTimes(1);
        expect(f.provider.queryRefund).toHaveBeenCalledWith(
            expect.objectContaining({ outTradeNo: merchant }),
        );
    });

    it('recovers a lost callback and rejects an invalid refund amount through HTTP', async () => {
        const { orderId, merchant } = await buy();
        f.provider.queryPayment.mockImplementation((no) =>
            Promise.resolve().then(() => f.paid(no)),
        );
        expect(await f.payments.reconcilePendingAttempts()).toEqual({
            checked: 1,
            settled: 1,
        });
        const refund = await request(app.getHttpServer())
            .post(`/api/orders/${orderId}/refunds`)
            .auth(token, { type: 'bearer' })
            .send({})
            .expect(200);
        const notification = {
            outRefundNo: refund.body.data.refundNo,
            status: 'SUCCESS',
            refundFee: 1,
            totalFee: 2900,
            outTradeNo: merchant,
        };
        await request(app.getHttpServer())
            .post('/api/payment/wechat/refund-callback')
            .send(notification)
            .expect(400);
        expect(f.rows('refund')[0].status).toBe('PROCESSING');
        await request(app.getHttpServer())
            .post('/api/payment/wechat/refund-callback')
            .send({ ...notification, refundFee: 2900 })
            .expect(200);
        expect(f.rows('order')[0].status).toBe('REFUNDED');
    });

    it('keeps a user refund pending until approval, including automatic reconciliation', async () => {
        f.config.config.mockResolvedValue({
            ...(await f.config.config()),
            autoApproveLimit: 0,
        });
        const { orderId, merchant } = await buy();
        await request(app.getHttpServer())
            .post('/api/payment/wechat/callback')
            .send(f.paid(merchant))
            .expect(200);
        const response = await request(app.getHttpServer())
            .post(`/api/orders/${orderId}/refunds`)
            .auth(token, { type: 'bearer' })
            .send({})
            .expect(200);
        expect(response.body.data.status).toBe('PENDING');
        await f.refunds.syncFromChannel(response.body.data.id);
        expect(f.provider.refund).not.toHaveBeenCalled();
        expect(f.provider.queryRefund).not.toHaveBeenCalled();
        await f.refunds.approve(response.body.data.id, 'admin');
        await f.refunds.syncFromChannel(response.body.data.id);
        expect(f.rows('order')[0].status).toBe('REFUNDED');
    });

    it('retains a renewal when the first purchase is refunded through HTTP', async () => {
        const first = await buy();
        await request(app.getHttpServer())
            .post('/api/payment/wechat/callback')
            .send(f.paid(first.merchant))
            .expect(200);
        const second = await buy();
        await request(app.getHttpServer())
            .post('/api/payment/wechat/callback')
            .send(f.paid(second.merchant))
            .expect(200);
        const snapshots = structuredClone(f.rows('order'));
        const response = await request(app.getHttpServer())
            .post(`/api/orders/${first.orderId}/refunds`)
            .auth(token, { type: 'bearer' })
            .send({})
            .expect(200);
        await f.refunds.syncFromChannel(response.body.data.id);
        expect(f.rows('subscription')[0].status).toBe('ACTIVE');
        expect(
            +f.rows('subscription')[0].expiresAt - Date.now(),
        ).toBeGreaterThan(29 * 86_400_000);
        expect(f.rows('order')[1].status).toBe('PAID');
        for (let i = 0; i < 2; i++) {
            expect(f.rows('order')[i].serviceStartsAt).toEqual(
                snapshots[i].serviceStartsAt,
            );
            expect(f.rows('order')[i].serviceEndsAt).toEqual(
                snapshots[i].serviceEndsAt,
            );
        }
    });

    it('requires authentication and rejects a non-member before creating a checkout', async () => {
        const { orderId } = await buy();
        await request(app.getHttpServer())
            .post(`/api/orders/${orderId}/pay`)
            .send({ openid: 'o' })
            .expect(401);
        f.prisma.membership.findUnique.mockResolvedValue(null);
        await request(app.getHttpServer())
            .post(`/api/orders/${orderId}/pay`)
            .auth(token, { type: 'bearer' })
            .send({ openid: 'o' })
            .expect(404);
        expect(f.rows('paymentAttempt')).toHaveLength(1);
    });
});
