import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { EmailService } from './email.service';
import type { AppConfig, ResendConfig } from '../../config';

@Global()
@Module({
    providers: [
        {
            provide: 'RESEND_CLIENT',
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
                const app = config.get<AppConfig>('app')!;
                const resend = config.get<ResendConfig>('resend')!;

                if (!app.isDevelopment && !resend.apiKey) {
                    throw new Error(
                        'Missing required environment variable: RESEND_API_KEY',
                    );
                }

                return new Resend(resend.apiKey || 're_dev_placeholder');
            },
        },
        EmailService,
    ],
    exports: [EmailService],
})
export class EmailModule {}
