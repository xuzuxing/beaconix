import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
    TerminusModule,
    HealthCheckService,
    HealthIndicatorService,
} from '@nestjs/terminus';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { MaintenanceGuard } from '../src/common/guards/maintenance.guard';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import request from 'supertest';
import { HealthController } from '../src/health.controller';
import { AppService } from '../src/app.service';
import { PrismaService } from '../src/infra/database/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { PrismaHealthIndicator } from '../src/infra/observability/health/prisma.health';
import { RedisHealthIndicator } from '../src/infra/observability/health/redis.health';
import { normalizeGlobalPrefix } from '../src/config/http-path';

for (const raw of ['/api', ' /backend/ ', ''])
    void describe(`Runtime availability (${raw})`, () => {
        let app: INestApplication;
        let redisMode: 'up' | 'stalled' | 'failed';
        let databaseDown: boolean;
        let databaseStalled: boolean;
        let settingsCalls: number;
        const prefix = normalizeGlobalPrefix(raw);
        beforeEach(async () => {
            redisMode = 'up';
            const ping = () =>
                redisMode === 'stalled'
                    ? new Promise<string>(() => undefined)
                    : redisMode === 'failed'
                      ? Promise.reject(
                            new Error('redis://secret@private.internal'),
                        )
                      : Promise.resolve('PONG');
            databaseDown = false;
            databaseStalled = false;
            const query = () =>
                databaseStalled
                    ? new Promise(() => undefined)
                    : databaseDown
                      ? Promise.reject(
                            new Error('postgresql://password@internal'),
                        )
                      : Promise.resolve([]);
            Reflect.defineMetadata(
                'design:paramtypes',
                [
                    AppService,
                    HealthCheckService,
                    PrismaHealthIndicator,
                    RedisHealthIndicator,
                ],
                HealthController,
            );
            const module = await Test.createTestingModule({
                imports: [
                    TerminusModule,
                    ThrottlerModule.forRoot([{ ttl: 60000, limit: 30 }]),
                ],
                controllers: [HealthController],
                providers: [
                    ThrottlerGuard,
                    {
                        provide: PrismaHealthIndicator,
                        useFactory: (indicators: HealthIndicatorService) =>
                            new PrismaHealthIndicator(
                                { $queryRaw: query } as never,
                                indicators,
                            ),
                        inject: [HealthIndicatorService],
                    },
                    {
                        provide: RedisHealthIndicator,
                        useFactory: (indicators: HealthIndicatorService) =>
                            new RedisHealthIndicator(
                                { getClient: () => ({ ping }) } as never,
                                indicators,
                            ),
                        inject: [HealthIndicatorService],
                    },
                    { provide: AppService, useValue: {} },
                    { provide: PrismaService, useValue: { $queryRaw: query } },
                    {
                        provide: RedisService,
                        useValue: { getClient: () => ({ ping }) },
                    },
                ],
            }).compile();
            app = module.createNestApplication();
            app.setGlobalPrefix(prefix);
            settingsCalls = 0;
            const settings = {
                getBoolean: () => {
                    settingsCalls++;
                    return new Promise<boolean>(() => undefined);
                },
            };
            app.useGlobalFilters(
                new GlobalExceptionFilter({
                    getBoolean: () => new Promise(() => undefined),
                } as never),
            );
            app.useGlobalGuards(
                new JwtAuthGuard(
                    new JwtService({ secret: 'offline-health' }),
                    new Reflector(),
                    {} as never,
                ),
                new MaintenanceGuard(
                    new Reflector(),
                    settings as never,
                    new ConfigService({ app: { globalPrefix: prefix } }),
                ),
                module.get(ThrottlerGuard),
            );
            await app.init();
        });
        afterEach(async () => {
            await app?.close();
            assert.equal(
                settingsCalls,
                0,
                'Health probes must never wait on settings',
            );
        });

        void it('keeps live up, bounds stalled Redis, redacts failures and recovers ready', async () => {
            await request(app.getHttpServer())
                .get(`${prefix}/health/ready`)
                .expect(200);
            redisMode = 'stalled';
            await request(app.getHttpServer())
                .get(`${prefix}/health/live`)
                .expect(200);
            const started = Date.now();
            const down = await request(app.getHttpServer())
                .get(`${prefix}/health/ready`)
                .expect(503);
            assert.ok(Date.now() - started < 3000);
            assert.equal(down.body.message.error.redis.status, 'down');
            redisMode = 'failed';
            const failure = await request(app.getHttpServer())
                .get(`${prefix}/health/ready`)
                .expect(503);
            assert.doesNotMatch(
                JSON.stringify(failure.body),
                /secret|private.internal/,
            );
            redisMode = 'up';
            await request(app.getHttpServer())
                .get(`${prefix}/health/ready`)
                .expect(200);
            if (prefix !== '/api')
                await request(app.getHttpServer())
                    .get('/api/health/live')
                    .expect(404);
        });

        void it('reports PostgreSQL failure without exposing connection details', async () => {
            databaseStalled = true;
            await request(app.getHttpServer())
                .get(`${prefix}/health/live`)
                .expect(200);
            const started = Date.now();
            await request(app.getHttpServer())
                .get(`${prefix}/health/ready`)
                .expect(503);
            assert.ok(Date.now() - started < 3000);
            databaseStalled = false;
            databaseDown = true;
            const result = await request(app.getHttpServer())
                .get(`${prefix}/health/ready`)
                .expect(503);
            assert.equal(result.body.message.error.postgresql.status, 'down');
            assert.doesNotMatch(
                JSON.stringify(result.body),
                /password|internal/,
            );
            databaseDown = false;
            await request(app.getHttpServer())
                .get(`${prefix}/health/ready`)
                .expect(200);
        });
    });
