import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { WechatApiError } from '../../infra/wechat/wechat.types';
import { GlobalExceptionFilter } from './global-exception.filter';

describe('GlobalExceptionFilter', () => {
    function createHost() {
        const json = jest.fn();
        const status = jest.fn().mockReturnValue({ json });
        const response = { status };
        const request = {
            method: 'POST',
            url: '/api/auth/wechat/miniprogram/scan-login',
        };
        const host = {
            switchToHttp: () => ({
                getResponse: () => response,
                getRequest: () => request,
            }),
        } as unknown as ArgumentsHost;

        return { host, json, status };
    }

    it('maps WechatApiError 40029 (invalid code) to 400 instead of 500', () => {
        const filter = new GlobalExceptionFilter();
        const { host, json, status } = createHost();

        filter.catch(
            new WechatApiError({
                platform: 'mp',
                endpoint: 'GET /sns/jscode2session',
                errcode: 40029,
                errmsg: 'invalid code',
            }),
            host,
        );

        expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
        expect(json).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: HttpStatus.BAD_REQUEST,
                message: '微信登录 code 无效或已过期',
            }),
        );
    });

    it('maps WechatApiError 45009 to 429', () => {
        const filter = new GlobalExceptionFilter();
        const { host, json, status } = createHost();

        filter.catch(
            new WechatApiError({
                platform: 'mp',
                endpoint: 'POST /wxa/getwxacodeunlimit',
                errcode: 45009,
                errmsg: 'too many requests',
            }),
            host,
        );

        expect(status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
        expect(json).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: HttpStatus.TOO_MANY_REQUESTS,
            }),
        );
    });
});
