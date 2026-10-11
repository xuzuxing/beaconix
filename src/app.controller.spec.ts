import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GlobalExceptionFilter } from './common/filters';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { TransformInterceptor } from './common/interceptors';
import { PrismaService } from './infra/database/prisma.service';
import { StatusPagesPublicController } from './modules/status-pages/status-pages-public.controller';
import { StatusPagesService } from './modules/status-pages/status-pages.service';

describe('AppController test pages', () => {
    const controller = new AppController(
        {} as AppService,
        {} as StatusPagesService,
    );

    it('exposes the rule engine test page data', () => {
        expect(controller.rulesTestPage()).toEqual({
            title: 'Beacon Rule Engine Test',
            apiBase: '/api',
            renderedAt: expect.any(String),
        });
    });

    it('ships the rules-test template with the expected hooks', () => {
        const templatePath = join(process.cwd(), 'views', 'rules-test.hbs');

        expect(existsSync(templatePath)).toBe(true);

        const html = readFileSync(templatePath, 'utf8');
        expect(html).toContain('{{title}}');
        expect(html).toContain('{{apiBase}}');
        expect(html).toContain("data-action='create'");
        expect(html).toContain('/rule-meta');
    });
});

describe('AppController status test endpoints', () => {
    let app: INestApplication;
    const verifyAsync = jest.fn();
    const getPublicBySlug = jest.fn((slug: string) => {
        if (!['release-health', '404-release'].includes(slug)) {
            throw new NotFoundException('Status page not found');
        }
        return { slug };
    });

    beforeAll(async () => {
        const module = await Test.createTestingModule({
            controllers: [AppController, StatusPagesPublicController],
            providers: [
                { provide: AppService, useValue: {} },
                { provide: StatusPagesService, useValue: { getPublicBySlug } },
                { provide: JwtService, useValue: { verifyAsync } },
                { provide: PrismaService, useValue: {} },
                { provide: APP_GUARD, useClass: JwtAuthGuard },
            ],
        }).compile();
        app = module.createNestApplication();
        app.setGlobalPrefix('api');
        app.useGlobalInterceptors(new TransformInterceptor());
        app.useGlobalFilters(new GlobalExceptionFilter());
        await app.init();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterAll(async () => {
        await app?.close();
    });

    it.each([200, 201, 400, 403, 404, 418, 500, 599])(
        'returns HTTP %i and the matching body without authentication',
        async (statusCode) => {
            const response = await request(app.getHttpServer())
                .get(`/api/status/${statusCode}`)
                .expect(statusCode);

            expect(response.body).toEqual({
                data: { statusCode },
                meta: { timestamp: expect.any(String) },
            });
            expect(verifyAsync).not.toHaveBeenCalled();
            expect(getPublicBySlug).not.toHaveBeenCalled();
        },
    );

    it.each(['/api/status', '/api/status/'])(
        'defaults to HTTP 200 when the code is omitted at %s',
        async (path) => {
            const response = await request(app.getHttpServer())
                .get(path)
                .expect(200);

            expect(response.body.data).toEqual({ statusCode: 200 });
            expect(verifyAsync).not.toHaveBeenCalled();
            expect(getPublicBySlug).not.toHaveBeenCalled();
        },
    );

    it.each([204, 205, 304])(
        'returns HTTP %i without a body as required by HTTP',
        async (statusCode) => {
            const response = await request(app.getHttpServer())
                .get(`/api/status/${statusCode}`)
                .expect(statusCode);

            expect(response.text).toBe('');
            expect(getPublicBySlug).not.toHaveBeenCalled();
        },
    );

    it.each([0, 199, 600, 999])(
        'rejects out-of-range numeric code %i with HTTP 400',
        async (statusCode) => {
            const response = await request(app.getHttpServer())
                .get(`/api/status/${statusCode}`)
                .expect(400);

            expect(response.body.statusCode).toBe(400);
            expect(response.body.message).toBe(
                'Status code must be an integer between 200 and 599',
            );
            expect(getPublicBySlug).not.toHaveBeenCalled();
        },
    );

    it.each(['-1', '400.5', '4.0e2'])(
        'rejects malformed code %s with HTTP 400',
        async (code) => {
            await request(app.getHttpServer())
                .get(`/api/status/${code}`)
                .expect(400);

            expect(getPublicBySlug).not.toHaveBeenCalled();
        },
    );

    it.each(['release-health', '404-release'])(
        'preserves the existing public status page route for %s',
        async (slug) => {
            const response = await request(app.getHttpServer())
                .get(`/api/status/${slug}`)
                .expect(200);

            expect(response.body.data).toEqual({ slug });
            expect(getPublicBySlug).toHaveBeenCalledWith(slug);
            expect(verifyAsync).not.toHaveBeenCalled();
        },
    );

    it('preserves the not-found response for an unknown public status page', async () => {
        await request(app.getHttpServer())
            .get('/api/status/unknown-page')
            .expect(404);

        expect(getPublicBySlug).toHaveBeenCalledWith('unknown-page');
    });
});
