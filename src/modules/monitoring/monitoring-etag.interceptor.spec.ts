import {
    BadRequestException,
    type CallHandler,
    type ExecutionContext,
} from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { MonitoringEtagInterceptor } from './monitoring-etag.interceptor';

function fixture(
    path: string,
    query: Record<string, unknown>,
    headers: Record<string, string | undefined> = {},
) {
    const request = { path, query, headers, id: 'request-1' };
    const response = {
        setHeader: jest.fn(),
        status: jest.fn(),
    };
    const context = {
        switchToHttp: () => ({
            getRequest: () => request,
            getResponse: () => response,
        }),
    } as unknown as ExecutionContext;
    const next: CallHandler = {
        handle: () => of({ kpis: { totalChecks: 1 } }),
    };

    return { context, next, request, response };
}

describe('MonitoringEtagInterceptor', () => {
    const interceptor = new MonitoringEtagInterceptor();
    const base = '/api/projects/p1/monitoring';

    it.each<[string, string, Record<string, unknown>]>([
        [
            'dashboard',
            '/dashboard',
            { range: '7d', tz: 'UTC', _t: '1792407963319' },
        ],
        [
            'availability',
            '/availability',
            { days: '7', tz: 'UTC', _t: '1792407963319' },
        ],
        [
            'status-codes',
            '/status-codes',
            { hours: '24', tz: 'UTC', _t: '1792407963319' },
        ],
    ])('ignores the `_t` cache buster on %s', async (_name, suffix, query) => {
        const { context, next, response } = fixture(`${base}${suffix}`, query);

        const body = await firstValueFrom(
            interceptor.intercept(context, next) as never,
        );

        expect(body).toEqual({
            data: { kpis: { totalChecks: 1 } },
            meta: expect.objectContaining({ requestId: 'request-1' }),
        });
        expect(response.setHeader).toHaveBeenCalledWith(
            'ETag',
            expect.stringContaining('W/"'),
        );
        expect(response.setHeader).toHaveBeenCalledWith(
            'Cache-Control',
            'private, no-cache',
        );
    });

    it.each<[string, Record<string, unknown>]>([
        ['an unknown parameter', { unexpected: '1' }],
        ['an empty parameter', { tz: '' }],
        ['a repeated parameter', { range: ['1h', '7d'] }],
    ])('still rejects %s', (_name, query) => {
        const { context, next } = fixture(`${base}/dashboard`, query);

        expect(() => interceptor.intercept(context, next)).toThrow(
            BadRequestException,
        );
    });

    it('answers 304 without a body when the tag matches', async () => {
        const query = { range: '1h', tz: 'UTC', _t: '1792407963319' };
        const first = fixture(`${base}/dashboard`, query);
        await firstValueFrom(
            interceptor.intercept(first.context, first.next) as never,
        );
        const tag = first.response.setHeader.mock.calls[0][1] as string;

        const second = fixture(`${base}/dashboard`, query, {
            'if-none-match': tag,
        });
        const body = await firstValueFrom(
            interceptor.intercept(second.context, second.next) as never,
        );

        expect(body).toBeUndefined();
        expect(second.response.status).toHaveBeenCalledWith(304);
    });
});
