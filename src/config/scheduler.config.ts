import { registerAs } from '@nestjs/config';
import { optionalEnv } from './env';

export interface SchedulerConfig {
    /**
     * IANA timezone the cron patterns are evaluated in (for example
     * `Asia/Shanghai`). Empty means the process timezone, which is what the
     * previous in-process `@Cron` decorators used.
     */
    timezone: string;
}

export const schedulerConfig = registerAs('scheduler', (): SchedulerConfig => ({
    timezone: optionalEnv('SCHEDULER_TIMEZONE', ''),
}));
