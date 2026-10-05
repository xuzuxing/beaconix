import type { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

jest.mock('ioredis', () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        connect: jest.fn(),
        quit: jest.fn(),
        ping: jest.fn(),
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
        expire: jest.fn(),
    })),
}));

function createService() {
    const configService = {
        get: jest.fn().mockReturnValue({
            url: 'redis://localhost:6379',
            keyPrefix: 'beacon:',
        }),
    };
    const service = new RedisService(configService as unknown as ConfigService);
    const client = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value;

    return { service, client };
}

describe('RedisService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('creates a lazy Redis client from config', () => {
        createService();

        expect(Redis).toHaveBeenCalledWith('redis://localhost:6379', {
            keyPrefix: 'beacon:',
            lazyConnect: true,
            maxRetriesPerRequest: 3,
        });
    });

    it('sets plain values with optional TTL', async () => {
        const { service, client } = createService();

        await service.set('key', 'value', 60);

        expect(client.set).toHaveBeenCalledWith('key', 'value', 'EX', 60);
    });

    it('round-trips JSON through the client', async () => {
        const { service, client } = createService();
        client.get.mockResolvedValue('{"ok":true}');

        await expect(service.getJson<{ ok: boolean }>('key')).resolves.toEqual({
            ok: true,
        });
        await service.setJson('key', { ok: true }, 60);

        expect(client.set).toHaveBeenCalledWith('key', '{"ok":true}', 'EX', 60);
    });
});
