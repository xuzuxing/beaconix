import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { AlipayApiError } from '../../../infra/alipay';
import { ALIPAY_NOTIFY_ERROR_CODES } from './alipay-payment.service';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { WechatVirtualPaymentService } from './wechat-virtual-payment.service';
import { RefundService } from '../refund/refund.service';

describe('PaymentController (Alipay callback)', () => {
    let controller: PaymentController;
    let paymentService: { handleAlipayCallback: jest.Mock };
    let response: { status: jest.Mock; type: jest.Mock };

    beforeEach(async () => {
        paymentService = { handleAlipayCallback: jest.fn() };

        const moduleRef: TestingModule = await Test.createTestingModule({
            controllers: [PaymentController],
            providers: [
                { provide: PaymentService, useValue: paymentService },
                { provide: WechatVirtualPaymentService, useValue: {} },
                { provide: RefundService, useValue: {} },
            ],
        }).compile();

        controller = moduleRef.get(PaymentController);

        response = {
            status: jest.fn().mockReturnThis(),
            type: jest.fn().mockReturnThis(),
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    function request(rawBody: string): Request {
        return {
            rawBody: Buffer.from(rawBody, 'utf8'),
        } as unknown as Request;
    }

    it('answers the bare text `success` for a settled notification', async () => {
        paymentService.handleAlipayCallback.mockResolvedValue({
            code: 'SUCCESS',
            message: '成功',
        });

        const reply = await controller.alipayCallback(
            request('out_trade_no=BW1'),
            { out_trade_no: 'BW1' },
            response as unknown as Response,
        );

        expect(reply).toBe('success');
        expect(response.status).toHaveBeenCalledWith(200);
        expect(response.type).toHaveBeenCalledWith('text/plain');
    });

    it('answers `failure` instead of throwing 500 when the notification is invalid', async () => {
        const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation(() => undefined);
        paymentService.handleAlipayCallback.mockRejectedValue(
            new AlipayApiError(
                'Alipay notification is missing out_trade_no (empty notification body, 0 bytes received)',
                ALIPAY_NOTIFY_ERROR_CODES.MISSING_OUT_TRADE_NO,
            ),
        );

        const reply = await controller.alipayCallback(
            request(''),
            {},
            response as unknown as Response,
        );

        expect(reply).toBe('failure');
        expect(response.status).toHaveBeenCalledWith(200);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining(
                ALIPAY_NOTIFY_ERROR_CODES.MISSING_OUT_TRADE_NO,
            ),
        );
    });

    it('keeps a real internal failure as a 5xx so Alipay retries it', async () => {
        paymentService.handleAlipayCallback.mockRejectedValue(
            new Error('db down'),
        );

        await expect(
            controller.alipayCallback(
                request('out_trade_no=BW1'),
                { out_trade_no: 'BW1' },
                response as unknown as Response,
            ),
        ).rejects.toThrow('db down');

        expect(response.status).not.toHaveBeenCalled();
    });

    it('logs why a well-formed notification was not settled', async () => {
        const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation(() => undefined);
        paymentService.handleAlipayCallback.mockResolvedValue({
            code: 'FAIL',
            message: 'Payment not found',
        });

        const reply = await controller.alipayCallback(
            request('out_trade_no=BW1'),
            { out_trade_no: 'BW1' },
            response as unknown as Response,
        );

        expect(reply).toBe('failure');
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('Payment not found'),
        );
    });
});
