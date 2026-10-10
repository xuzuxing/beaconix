import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import Redis from 'ioredis';
import type { MonitorModel } from '../../../generated/prisma/models';
import { ApplicationCheckRuntime } from './application-runtime';
import { RedisChecker } from './redis.checker';

// Only parses the bounded RESP2 string-array commands sent by the real test client.
function consumeCommands(buffer: Buffer): {
    commands: string[][];
    rest: Buffer;
} {
    const commands: string[][] = [];
    let consumed = 0;
    while (consumed < buffer.length) {
        let offset = consumed;
        const end = buffer.indexOf('\r\n', offset);
        if (end < 0) break;
        const count = Number(buffer.subarray(offset + 1, end).toString());
        if (
            buffer[offset] !== 42 ||
            !Number.isInteger(count) ||
            count < 1 ||
            count > 16
        )
            throw new Error('Unexpected test command');
        offset = end + 2;
        const command: string[] = [];
        for (let i = 0; i < count; i += 1) {
            const sizeEnd = buffer.indexOf('\r\n', offset);
            if (sizeEnd < 0)
                return { commands, rest: buffer.subarray(consumed) };
            const size = Number(
                buffer.subarray(offset + 1, sizeEnd).toString(),
            );
            if (
                buffer[offset] !== 36 ||
                !Number.isInteger(size) ||
                size < 0 ||
                size > 8192
            )
                throw new Error('Unexpected test argument');
            offset = sizeEnd + 2;
            if (buffer.length < offset + size + 2)
                return { commands, rest: buffer.subarray(consumed) };
            command.push(buffer.subarray(offset, offset + size).toString());
            offset += size + 2;
        }
        commands.push(command);
        consumed = offset;
    }
    return { commands, rest: buffer.subarray(consumed) };
}

describe('Real ioredis lifecycle and authentication', () => {
    afterEach(() => jest.restoreAllMocks());
    it('destroys the socket immediately when the peer remains half-open', async () => {
        const sockets = new Set<Socket>();
        const server = createServer({ allowHalfOpen: true }, (socket) => {
            sockets.add(socket);
            socket.on('data', () => undefined);
            socket.on('error', () => undefined);
            socket.on('close', () => sockets.delete(socket));
        });
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
        );
        const disconnect = jest.spyOn(Redis.prototype, 'disconnect');
        try {
            const checker = new RedisChecker(
                new ApplicationCheckRuntime({
                    resolve: () => Promise.resolve('127.0.0.1'),
                }),
            );
            const result = await checker.run({
                type: 'REDIS',
                target: `redis.example.com:${(server.address() as AddressInfo).port}`,
                config: { tls: false },
                timeout: 150,
            } as unknown as MonitorModel);
            expect(result.success).toBe(false);
            expect(disconnect).toHaveBeenCalled();
            const client = disconnect.mock.contexts[0] as Redis;
            expect(client.stream.destroyed).toBe(true);
        } finally {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
    it('fails explicit AUTH instead of accepting PONG from an unauthenticated server', async () => {
        const commands: string[] = [];
        const sockets = new Set<Socket>();
        const server = createServer((socket) => {
            sockets.add(socket);
            socket.on('error', () => undefined);
            socket.on('close', () => sockets.delete(socket));
            let pending: Buffer = Buffer.alloc(0);
            socket.on('data', (data) => {
                const parsed = consumeCommands(
                    Buffer.concat([pending, Buffer.from(data)]),
                );
                pending = parsed.rest;
                for (const command of parsed.commands) {
                    const name = command[0].toUpperCase();
                    commands.push(name);
                    socket.write(
                        name === 'AUTH'
                            ? '-ERR Client sent AUTH, but no password is set\r\n'
                            : name === 'PING'
                              ? '+PONG\r\n'
                              : '+OK\r\n',
                    );
                }
            });
        });
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
        );
        try {
            const checker = new RedisChecker(
                new ApplicationCheckRuntime({
                    resolve: () => Promise.resolve('127.0.0.1'),
                }),
            );
            const result = await checker.run({
                type: 'REDIS',
                target: `redis.example.com:${(server.address() as AddressInfo).port}`,
                config: { tls: false, password: 'private-password' },
                timeout: 1000,
            } as unknown as MonitorModel);
            expect(result.success).toBe(false);
            expect(commands).toContain('AUTH');
            expect(commands).not.toContain('PING');
            expect(JSON.stringify(result)).not.toContain('private-password');
        } finally {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
