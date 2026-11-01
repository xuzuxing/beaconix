import { Global, Injectable, Module } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../infra/database/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { ScheduledJobRegistry } from '../../infra/scheduler/scheduled-job.registry';
import { SCHEDULED_JOBS_QUEUE } from '../../infra/scheduler/scheduled-jobs.constants';
import { WechatModule } from '../../infra/wechat/wechat.module';
import { WechatPayClient } from '../../infra/wechat/pay';
import { MiniprogramClient } from '../../infra/wechat/miniprogram';
import { SettingsModule } from '../settings/settings.module';
import { SettingsService } from '../settings/settings.service';
import { QuotaService } from '../../shared/quota/quota.service';
import { RuleEvaluationModule } from '../rules/rule-evaluation.module';
import { RuleEvaluatorService } from '../rules/rule-evaluator.service';
import { RulesModule } from '../rules/rules.module';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../email/email.service';
import {
    MONITOR_CHECK_QUEUE,
    MONITOR_SCAN_QUEUE,
} from '../checker/checker.queue';
import { NotifierCoreModule } from './notifier-core.module';
import { NotifierModule } from './notifier.module';
import { NotifierService } from './notifier.service';
import { NotificationsProcessor } from './notifications.processor';
import { AlertOutboxService } from './alert-outbox.service';
import { NOTIFICATION_QUEUE } from './notifier.queue';
import type { NotificationPayload } from './notifier.types';

@Injectable()
class RuntimeConsumer {
    constructor(
        readonly notifier: NotifierService,
        readonly evaluator: RuleEvaluatorService,
    ) {}
}

@Module({
    imports: [NotifierCoreModule, RuleEvaluationModule],
    providers: [RuntimeConsumer],
    exports: [RuntimeConsumer],
})
class RuntimeConsumerModule {}

@Injectable()
class LegacyConsumer extends RuntimeConsumer {
    constructor(
        notifier: NotifierService,
        evaluator: RuleEvaluatorService,
        readonly settings: SettingsService,
        readonly miniprogram: MiniprogramClient,
        readonly pay: WechatPayClient,
    ) {
        super(notifier, evaluator);
    }
}

@Module({
    imports: [NotifierModule, RulesModule, SettingsModule, WechatModule],
    providers: [LegacyConsumer],
    exports: [LegacyConsumer],
})
class LegacyConsumerModule {}

@Injectable()
class GlobalInfrastructureConsumer {
    constructor(
        readonly settings: SettingsService,
        readonly miniprogram: MiniprogramClient,
        readonly pay: WechatPayClient,
        readonly email: EmailService,
    ) {}
}

// Existing feature modules rely on global exports without explicit imports.
@Module({
    providers: [GlobalInfrastructureConsumer],
    exports: [GlobalInfrastructureConsumer],
})
class GlobalConsumerModule {}

async function createFixture(legacy = false) {
    const prisma = {
        setting: { findUnique: jest.fn().mockResolvedValue(null) },
        notificationChannel: { findUnique: jest.fn() },
        notificationLog: { create: jest.fn() },
    };
    const queue = { add: jest.fn() };
    const registry = { register: jest.fn() };
    @Global()
    @Module({
        providers: [
            { provide: PrismaService, useValue: prisma },
            ...(legacy
                ? [
                      { provide: QuotaService, useValue: {} },
                      { provide: NotificationsService, useValue: {} },
                      { provide: ScheduledJobRegistry, useValue: registry },
                  ]
                : []),
        ],
        exports: [
            PrismaService,
            ...(legacy
                ? [QuotaService, NotificationsService, ScheduledJobRegistry]
                : []),
        ],
    })
    class FixtureInfrastructure {}

    const builder = Test.createTestingModule({
        imports: [
            ConfigModule.forRoot({
                isGlobal: true,
                ignoreEnvFile: true,
                ignoreEnvVars: true,
                load: [
                    () => ({
                        app: {
                            isDevelopment: true,
                            webUrl: 'https://console.example.test',
                        },
                        resend: {
                            apiKey: '',
                            fromEmail: 'alerts@example.test',
                            fromName: 'Beacon',
                        },
                        redis: {
                            url: 'redis://127.0.0.1:1',
                            keyPrefix: 'composition-test:',
                        },
                    }),
                ],
            }),
            FixtureInfrastructure,
            legacy ? LegacyConsumerModule : RuntimeConsumerModule,
            ...(legacy ? [GlobalConsumerModule] : []),
        ],
    })
        .overrideProvider(RedisService)
        .useValue({});
    for (const name of [
        NOTIFICATION_QUEUE,
        MONITOR_SCAN_QUEUE,
        MONITOR_CHECK_QUEUE,
        SCHEDULED_JOBS_QUEUE,
    ]) {
        builder.overrideProvider(getQueueToken(name)).useValue(queue);
    }
    return { moduleRef: await builder.compile(), prisma, queue, registry };
}

describe('Monitoring runtime module boundaries', () => {
    it('initializes delivery/rule cores without management routes or legacy workers', async () => {
        const { moduleRef, prisma, queue } = await createFixture();
        try {
            await moduleRef.init();
            const modules = [...moduleRef.get(ModulesContainer).values()];
            expect(modules.flatMap((entry) => [...entry.controllers])).toEqual(
                [],
            );
            for (const token of [
                NotificationsProcessor,
                AlertOutboxService,
                ScheduledJobRegistry,
                WechatPayClient,
                getQueueToken(MONITOR_CHECK_QUEUE),
                getQueueToken(MONITOR_SCAN_QUEUE),
                getQueueToken(SCHEDULED_JOBS_QUEUE),
            ]) {
                expect(() => moduleRef.get(token)).toThrow();
            }
            const consumer = moduleRef.get(RuntimeConsumer);
            expect(
                consumer.evaluator.evaluate(
                    {
                        type: 'condition',
                        id: 'failed-check',
                        field: 'success',
                        operator: 'eq',
                        value: false,
                    },
                    { success: false },
                ),
            ).toBe(true);

            const send = jest
                .spyOn(moduleRef.get(EmailService), 'send')
                .mockResolvedValue(undefined);
            prisma.notificationChannel.findUnique.mockResolvedValue({
                id: 'channel-1',
                type: 'EMAIL',
                config: { to: ['ops@example.test'] },
            });
            const payload: NotificationPayload = {
                monitorId: 'monitor-1',
                monitorName: 'API',
                monitorType: 'HTTP',
                target: 'https://example.test',
                organizationId: 'org-1',
                previousStatus: 'UP',
                status: 'DOWN',
                event: 'DOWN',
                failCount: 3,
                latency: 50,
                error: 'Connection refused',
                checkedAt: new Date(),
            };
            await expect(
                consumer.notifier.deliver('channel-1', payload),
            ).resolves.toBe(true);
            expect(send).toHaveBeenCalledTimes(1);
            expect(prisma.notificationLog.create).toHaveBeenCalledTimes(1);
            expect(queue.add).not.toHaveBeenCalled();
        } finally {
            await moduleRef.close();
            jest.restoreAllMocks();
        }
    });

    it('preserves legacy exports and shares core instances across both import paths', async () => {
        const { moduleRef } = await createFixture(true);
        try {
            const consumer = moduleRef.get(LegacyConsumer);
            expect(consumer.notifier).toBe(moduleRef.get(NotifierService));
            expect(consumer.evaluator).toBe(
                moduleRef.get(RuleEvaluatorService),
            );
            expect(consumer.settings).toBe(moduleRef.get(SettingsService));
            expect(consumer.miniprogram).toBe(moduleRef.get(MiniprogramClient));
            expect(consumer.pay).toBeInstanceOf(WechatPayClient);
            const globalConsumer = moduleRef.get(GlobalInfrastructureConsumer);
            expect(globalConsumer.settings).toBe(consumer.settings);
            expect(globalConsumer.miniprogram).toBe(consumer.miniprogram);
            expect(globalConsumer.pay).toBe(consumer.pay);
            expect(globalConsumer.email).toBe(moduleRef.get(EmailService));
            expect(moduleRef.get(NotificationsProcessor)).toBeInstanceOf(
                NotificationsProcessor,
            );
            expect(moduleRef.get(AlertOutboxService)).toBeInstanceOf(
                AlertOutboxService,
            );
            const modules = [...moduleRef.get(ModulesContainer).values()];
            for (const token of [
                NotifierService,
                RuleEvaluatorService,
                SettingsService,
                MiniprogramClient,
                getQueueToken(NOTIFICATION_QUEUE),
            ]) {
                expect(
                    modules.filter((entry) => entry.providers.has(token)),
                ).toHaveLength(1);
            }
        } finally {
            await moduleRef.close();
        }
    });
});
