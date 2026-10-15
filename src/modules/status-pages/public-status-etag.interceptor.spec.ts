import {
    BadRequestException,
    type CallHandler,
    type ExecutionContext,
} from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { PublicStatusEtagInterceptor } from './public-status-etag.interceptor';

function fixture(
    query: Record<string, unknown> = {},
    headers: Record<string, string | undefined> = {},
) {
    const request = { query, headers, id: 'request-1' };
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
        handle: () => of({ slug: 'acme-status' }),
    };

    return { context, next, request, response };
}

describe('PublicStatusEtagInterceptor', () => {
    const interceptor = new PublicStatusEtagInterceptor();

    it('wraps the payload and tags the untagged body', async () => {
        const { context, next, response } = fixture({ tz: 'Asia/Shanghai' });

        const body = await firstValueFrom(
            interceptor.intercept(context, next) as never,
        );

        expect(body).toEqual({
            data: { slug: 'acme-status' },
            meta: expect.objectContaining({ requestId: 'request-1' }),
        });
        expect(response.setHeader).toHaveBeenCalledWith(
            'ETag',
            expect.stringContaining('W/"'),
        );
        expect(response.setHeader).toHaveBeenCalledWith(
            'Cache-Control',
            'public, no-cache',
        );
    });

    it.each([
        ['a repeated parameter', { tz: ['Asia/Shanghai', 'UTC'] }],
        ['an empty parameter', { tz: '' }],
        ['an unknown parameter', { days: '3' }],
    ])('rejects %s', (_name, query) => {
        const { context, next } = fixture(query);

        expect(() => interceptor.intercept(context, next)).toThrow(
            BadRequestException,
        );
    });

    it('answers 304 without a body when the tag matches', async () => {
        const first = fixture({ tz: 'UTC' });
        await firstValueFrom(
            interceptor.intercept(first.context, first.next) as never,
        );
        const tag = first.response.setHeader.mock.calls[0][1] as string;

        const second = fixture({ tz: 'UTC' }, { 'if-none-match': tag });
        const body = await firstValueFrom(
            interceptor.intercept(second.context, second.next) as never,
        );

        expect(body).toBeUndefined();
        expect(second.response.status).toHaveBeenCalledWith(304);
    });

    it('serves the payload again when the tag does not match', async () => {
        const { context, next, response } = fixture(
            { tz: 'UTC' },
            { 'if-none-match': 'W/"stale"' },
        );

        const body = await firstValueFrom(
            interceptor.intercept(context, next) as never,
        );

        expect(body).toEqual(
            expect.objectContaining({ data: { slug: 'acme-status' } }),
        );
        expect(response.status).not.toHaveBeenCalled();
    });
});
