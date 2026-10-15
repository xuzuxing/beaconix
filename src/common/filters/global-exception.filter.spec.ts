import { ArgumentsHost, HttpStatus, Logger } from '@nestjs/common';
import { WechatApiError } from '../../infra/wechat/wechat.types';
import { SettingsService } from '../../modules/settings';
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

    function createFilter({ debugMode = false } = {}) {
        const settingsService = {
            getBoolean: jest.fn().mockResolvedValue(debugMode),
        } as unknown as SettingsService;

        return new GlobalExceptionFilter(settingsService);
    }

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('maps WechatApiError 40029 (invalid code) to 400 instead of 500', async () => {
        const filter = createFilter();
        const { host, json, status } = createHost();

        await filter.catch(
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

    it('maps WechatApiError 45009 to 429', async () => {
        const filter = createFilter();
        const { host, json, status } = createHost();

        await filter.catch(
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

    it('omits the error detail unless develop.debugMode is on', async () => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation(
            () => undefined,
        );
        const filter = createFilter();
        const { host, json } = createHost();

        await filter.catch(new Error('boom'), host);

        expect(json).toHaveBeenCalledWith(
            expect.not.objectContaining({ detail: expect.anything() }),
        );
    });

    it('adds the error detail to 5xx responses when develop.debugMode is on', async () => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation(
            () => undefined,
        );
        const filter = createFilter({ debugMode: true });
        const { host, json } = createHost();

        await filter.catch(new Error('boom'), host);

        expect(json).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
                detail: 'boom',
            }),
        );
    });

    it('keeps working when the setting cannot be read', async () => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation(
            () => undefined,
        );
        const settingsService = {
            getBoolean: jest.fn().mockRejectedValue(new Error('db down')),
        } as unknown as SettingsService;
        const filter = new GlobalExceptionFilter(settingsService);
        const { host, json } = createHost();

        await filter.catch(new Error('boom'), host);

        expect(json).toHaveBeenCalledWith(
            expect.not.objectContaining({ detail: expect.anything() }),
        );
    });
});
