import { execFile } from 'node:child_process';
import { PingRunner } from './ping.checker';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));

describe('PingRunner', () => {
    afterEach(() => jest.restoreAllMocks());

    it.each(['linux', 'win32'] as const)(
        'uses bounded argument-based system execution on %s',
        async (platform) => {
            (execFile as unknown as jest.Mock).mockImplementation(
                (_, __, ___, callback) => {
                    callback(null, 'reply', '');
                },
            );
            expect(
                await new PingRunner().run('1.1.1.1', 500, platform),
            ).toMatchObject({ stdout: 'reply' });
            expect(execFile).toHaveBeenLastCalledWith(
                platform === 'win32' ? 'ping.exe' : 'ping',
                platform === 'win32'
                    ? ['-n', '1', '-w', '500', '1.1.1.1']
                    : ['-n', '-c', '1', '-W', '1', '1.1.1.1'],
                expect.objectContaining({
                    timeout: 500,
                    maxBuffer: 16 * 1024,
                    shell: false,
                    windowsHide: true,
                    killSignal: 'SIGKILL',
                }),
                expect.any(Function),
            );
        },
    );
});
