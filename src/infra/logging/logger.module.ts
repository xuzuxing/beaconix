import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import {
    LoggerModule as PinoLoggerModule,
    PARAMS_PROVIDER_TOKEN,
    type Params,
} from 'nestjs-pino';
import { ClsService } from 'nestjs-cls';
import pino, { type LoggerOptions } from 'pino';
import type { LoggerConfig } from '../../config';
import { ClsModule } from '../cls/cls.module';
import { CLS_KEY_REQUEST_ID } from '../cls/request-id.cls';
import { createPinoConfig } from './pino-logger.config';
import { StructuredLoggerService } from './structured-logger.service';
import { ConfigService } from '@nestjs/config';

type PinoTransportStream = ReturnType<typeof pino.transport> & {
    readonly closed: boolean;
    readonly destroyed: boolean;
    once(event: 'close', callback: () => void): void;
    ref(): void;
    end(): void;
};

@Global()
@Module({
    imports: [
        ClsModule,
        PinoLoggerModule.forRootAsync({
            inject: [ConfigService, ClsService],
            useFactory: (
                configService: ConfigService,
                clsService: ClsService,
            ) => {
                const logger = configService.get<LoggerConfig>('logger')!;
                const env = configService.get<string>('app.env');
                const globalPrefix =
                    configService.get<string>('app.globalPrefix');

                const excludePaths = logger.excludePaths.map(
                    (path) => `${globalPrefix}${path}`,
                );

                const params = createPinoConfig(
                    logger.dir,
                    logger.level,
                    logger.prettyPrint,
                    logger.toFile,
                    excludePaths,
                    logger.sensitiveFields,
                    {
                        serviceName: logger.serviceName,
                        toConsole: logger.toConsole,
                        env,
                        getRequestId: () =>
                            clsService.isActive()
                                ? clsService.get<string>(CLS_KEY_REQUEST_ID)
                                : undefined,
                        loki: logger.loki,
                    },
                );

                const { transport, ...httpOptions } =
                    params.pinoHttp as LoggerOptions;
                if (!transport) return params;

                // Share one stream between nestjs-pino's HTTP and out-of-context loggers.
                const stream = pino.transport(transport);
                stream.on('error', (error: Error) => {
                    process.stderr.write(
                        `[logger transport] ${error.message}\n`,
                    );
                });
                return { ...params, pinoHttp: [httpOptions, stream] };
            },
        }),
    ],
    providers: [StructuredLoggerService],
    exports: [PinoLoggerModule, StructuredLoggerService],
})
export class LoggerModule implements OnApplicationShutdown {
    constructor(
        @Inject(PARAMS_PROVIDER_TOKEN) private readonly params: Params,
    ) {}

    async onApplicationShutdown(): Promise<void> {
        if (!Array.isArray(this.params.pinoHttp)) return;
        const stream = this.params
            .pinoHttp[1] as unknown as PinoTransportStream;
        if (stream.closed || stream.destroyed) return;

        await new Promise<void>((resolve) => {
            stream.once('close', resolve);
            stream.ref();
            // end() invokes the targets' close hooks.
            // thread-stream bounds its synchronous end wait to ten seconds.
            stream.end();
        });
    }
}
