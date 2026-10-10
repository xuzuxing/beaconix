import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import {
    appConfig,
    databaseConfig,
    jwtConfig,
    loggerConfig,
    probeConfig,
    redisConfig,
    resendConfig,
    schedulerConfig,
    storageConfig,
    throttlerConfig,
    twoFactorConfig,
    wechatConfig,
    JwtConfig,
    ThrottlerConfig,
} from './config';
import { PrismaModule } from './infra/database/prisma.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { ScheduledJobsModule } from './infra/scheduler/scheduled-jobs.module';
import { WechatModule } from './infra/wechat/wechat.module';
import { JwtAuthGuard } from './common/guards';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { MembershipsModule } from './modules/memberships/memberships.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { SprintsModule } from './modules/sprints/sprints.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { CommentsModule } from './modules/comments/comments.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { LabelsModule } from './modules/labels/labels.module';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { EmailModule } from './modules/email/email.module';
import { CronModule } from './modules/cron/cron.module';
import { MonitorsModule } from './modules/monitors/monitors.module';
import { RulesModule } from './modules/rules/rules.module';
import { ProbesModule } from './modules/probes/probes.module';
import { ProbeEnrollmentModule } from './modules/probes/probe-enrollment.module';
import { CheckerModule } from './modules/checker/checker.module';
import { StateModule } from './modules/state/state.module';
import { NotifierModule } from './modules/notifier/notifier.module';
import { StatusPagesModule } from './modules/status-pages/status-pages.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { BillingModule } from './modules/billing/billing.module';
import { DeveloperApiModule } from './modules/developer-api/developer-api.module';
import { isDeveloperApiRoute } from './modules/developer-api/common/developer-throttle';
import { QuotaModule } from './shared/quota/quota.module';
import { AdminModule } from './modules/admin/admin.module';
import { SettingsModule } from './modules/settings';
import { ClsModule } from './infra/cls/cls.module';
import { CacheModule } from './infra/cache/cache.module';
import { LoggerModule } from './infra/logging/logger.module';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            envFilePath: '.env',
            load: [
                appConfig,
                databaseConfig,
                jwtConfig,
                loggerConfig,
                probeConfig,
                redisConfig,
                resendConfig,
                schedulerConfig,
                storageConfig,
                throttlerConfig,
                twoFactorConfig,
                wechatConfig,
            ],
        }),
        JwtModule.registerAsync({
            global: true,
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
                const jwt = config.get<JwtConfig>('jwt')!;
                return {
                    secret: jwt.secret,
                    signOptions: {
                        expiresIn:
                            jwt.accessExpiresIn as `${number}${'s' | 'm' | 'h' | 'd'}`,
                    },
                };
            },
        }),
        ThrottlerModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
                const throttler = config.get<ThrottlerConfig>('throttler')!;
                return [
                    {
                        name: 'default',
                        ttl: throttler.ttl * 1000,
                        limit: throttler.limit,
                    },
                    {
                        name: 'developer',
                        ttl: throttler.developerTtl * 1000,
                        limit: throttler.developerLimit,
                        // Only apply the developer bucket to /api/developer/v1.
                        skipIf: (context) => !isDeveloperApiRoute(context),
                    },
                ];
            },
        }),
        // Recurring work runs through ScheduledJobsModule (BullMQ), so the
        // in-process ScheduleModule is intentionally not registered: a `@Cron`
        // decorator would silently never fire. Add ScheduleModule.forRoot() back
        // if an in-process timer is ever needed again.
        PrismaModule,
        // infra
        CacheModule,
        ClsModule,
        LoggerModule,
        QueueModule,
        RedisModule,
        ScheduledJobsModule,
        WechatModule,
        // business
        SettingsModule,
        EmailModule,
        AuthModule,
        UsersModule,
        OrganizationsModule,
        MembershipsModule,
        InvitationsModule,
        ProjectsModule,
        SprintsModule,
        TasksModule,
        CommentsModule,
        AttachmentsModule,
        LabelsModule,
        AuditLogsModule,
        NotificationsModule,
        CronModule,
        MonitorsModule,
        RulesModule,
        ProbesModule,
        ProbeEnrollmentModule,
        CheckerModule,
        StateModule,
        NotifierModule,
        StatusPagesModule,
        MonitoringModule,
        BillingModule,
        DeveloperApiModule,
        QuotaModule,
        AdminModule,
    ],
    controllers: [AppController],
    providers: [
        AppService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
    ],
})
export class AppModule {}
