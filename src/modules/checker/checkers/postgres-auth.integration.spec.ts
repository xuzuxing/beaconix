import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import type { MonitorModel } from '../../../generated/prisma/models';
import { ApplicationCheckRuntime } from './application-runtime';
import { PostgresChecker } from './postgres.checker';

describe('Real pg authentication isolation', () => {
    it('does not send PGPASSWORD when the monitor password is omitted', async () => {
        const previous = process.env.PGPASSWORD;
        process.env.PGPASSWORD = 'synthetic-process-password-must-not-leak';
        const sockets = new Set<Socket>();
        let password: string | undefined;
        const server = createServer((socket) => {
            sockets.add(socket);
            socket.on('error', () => undefined);
            socket.on('close', () => sockets.delete(socket));
            let startup = true;
            let pending = Buffer.alloc(0);
            socket.on('data', (data) => {
                pending = Buffer.concat([pending, Buffer.from(data)]);
                if (startup) {
                    if (
                        pending.length < 4 ||
                        pending.length < pending.readInt32BE(0)
                    )
                        return;
                    pending = pending.subarray(pending.readInt32BE(0));
                    startup = false;
                    const request = Buffer.alloc(9);
                    request[0] = 'R'.charCodeAt(0);
                    request.writeInt32BE(8, 1);
                    request.writeInt32BE(3, 5); // AuthenticationCleartextPassword.
                    socket.write(request);
                }
                if (pending.length >= 5 && pending[0] === 'p'.charCodeAt(0)) {
                    const length = pending.readInt32BE(1);
                    if (pending.length < length + 1) return;
                    password = pending.subarray(5, length).toString('utf8');
                    socket.end();
                }
            });
        });
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
        );
        try {
            const runtime = new ApplicationCheckRuntime({
                resolve: () => Promise.resolve('127.0.0.1'),
            });
            const result = await new PostgresChecker(runtime).run({
                type: 'POSTGRESQL',
                target: `db.example.com:${(server.address() as AddressInfo).port}`,
                config: { username: 'monitor', database: 'health', tls: false },
                timeout: 1000,
            } as unknown as MonitorModel);
            expect(password).toBe('');
            expect(result.success).toBe(false);
            expect(JSON.stringify(result)).not.toContain(
                'synthetic-process-password',
            );
        } finally {
            if (previous === undefined) delete process.env.PGPASSWORD;
            else process.env.PGPASSWORD = previous;
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
