import { tmpdir } from 'node:os';
import type { LoggerOptions, TransportMultiOptions } from 'pino';
import { createPinoConfig } from './pino-logger.config';

describe.each([false, true])('createPinoConfig with Loki=%s', (hasLoki) => {
    it.each([
        [true, false, true],
        [true, false, false],
        [true, true, true],
        [true, true, false],
        [false, false, true],
        [false, false, false],
        [false, true, true],
        [false, true, false],
    ])(
        'routes logs with console=%s, pretty=%s, file=%s',
        (toConsole, prettyPrint, toFile) => {
            const options = createPinoConfig(
                tmpdir(),
                'info',
                prettyPrint,
                toFile,
                [],
                [],
                {
                    toConsole,
                    env: 'test',
                    loki: hasLoki
                        ? {
                              url: 'http://localhost:3100',
                              batching: {
                                  interval: 5,
                                  maxBufferSize: 1000,
                              },
                          }
                        : undefined,
                },
            ).pinoHttp as LoggerOptions;
            const transport = options.transport as
                TransportMultiOptions | undefined;

            if (!toFile && !(toConsole && prettyPrint) && !hasLoki) {
                expect(transport).toBeUndefined();
                expect(options.level).toBe(toConsole ? 'info' : 'silent');
                return;
            }

            expect(transport).toBeDefined();
            const targets = transport!.targets;
            const stdoutTargets = targets.filter(
                (target) =>
                    'target' in target &&
                    target.target === 'pino/file' &&
                    target.options?.destination === 1,
            );
            const prettyTargets = targets.filter(
                (target) =>
                    'target' in target &&
                    target.target === require.resolve('pino-pretty'),
            );
            const fileTargets = targets.filter(
                (target) =>
                    'target' in target &&
                    target.target === 'pino/file' &&
                    typeof target.options?.destination === 'string',
            );
            const lokiTargets = targets.filter(
                (target) =>
                    'target' in target &&
                    target.target === require.resolve('pino-loki'),
            );

            expect(stdoutTargets).toHaveLength(
                toConsole && !prettyPrint ? 1 : 0,
            );
            expect(prettyTargets).toHaveLength(
                toConsole && prettyPrint ? 1 : 0,
            );
            expect(fileTargets).toHaveLength(toFile ? 1 : 0);
            expect(lokiTargets).toHaveLength(hasLoki ? 1 : 0);
            expect(options.formatters!.level!('info', 30)).toEqual({
                level: 30,
                levelName: 'info',
            });
        },
    );
});
