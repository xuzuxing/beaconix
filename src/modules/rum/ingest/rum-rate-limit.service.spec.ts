import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { RumRateLimitService } from './rum-rate-limit.service';

describe('RumRateLimitService', () => {
    function setup(result: unknown) {
        const evalMock = jest.fn().mockResolvedValue(result);
        const service = new RumRateLimitService(
            { getClient: () => ({ eval: evalMock }) } as never,
            {
                get: () => ({
                    maxAppsPerProject: 20,
                    appRequestsPerMinute: 2,
                    sourceRequestsPerMinute: 1,
                    errorRetentionDays: 90,
                }),
            } as never,
        );
        return { service, evalMock };
    }

    it('accepts counts within both limits', async () => {
        await expect(
            setup([2, 1]).service.consume('app', 'ip'),
        ).resolves.toBeUndefined();
    });

    it('rejects when either bucket is over limit', async () => {
        await expect(
            setup([2, 2]).service.consume('app', 'ip'),
        ).rejects.toBeInstanceOf(HttpException);
    });

    it('fails closed when Redis is unavailable', async () => {
        const { service, evalMock } = setup([1, 1]);
        evalMock.mockRejectedValueOnce(new Error('offline'));
        await expect(service.consume('app', 'ip')).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
    });
});
