import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '../../infra/database/prisma.service';
import { PrismaModule } from '../../infra/database/prisma.module';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { ProjectPermissionsService } from './project-permissions.service';
import {
    OrganizationProjectPermissionsController,
    ProjectPermissionsController,
} from './project-permissions.controller';

// Real Nest routing, JWT, guards and validation with mocked database delegates.
// This is not the disposable PostgreSQL HTTP acceptance suite.
describe('Permission HTTP credential and validation boundaries', () => {
    let app: INestApplication;
    let jwt: JwtService;
    const db = {
        user: { findFirst: jest.fn() },
        organization: { findFirst: jest.fn().mockResolvedValue({ id: 'org' }) },
        membership: { findUnique: jest.fn() },
        project: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'project',
                organizationId: 'org',
                status: 'ACTIVE',
            }),
        },
        projectMembership: { findUnique: jest.fn() },
        $transaction: jest.fn(),
    };
    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                PrismaModule,
                AuthorizationModule,
                JwtModule.register({ secret: 'permission-unit-test-secret' }),
            ],
            controllers: [
                OrganizationProjectPermissionsController,
                ProjectPermissionsController,
            ],
            providers: [
                ProjectPermissionsService,
                { provide: APP_GUARD, useClass: JwtAuthGuard },
            ],
        })
            .overrideProvider(PrismaService)
            .useValue(db)
            .compile();
        app = moduleRef.createNestApplication();
        app.setGlobalPrefix('api');
        app.useGlobalPipes(
            new ValidationPipe({
                whitelist: true,
                forbidNonWhitelisted: true,
                transform: true,
            }),
        );
        app.useGlobalInterceptors(new TransformInterceptor());
        await app.init();
        jwt = moduleRef.get(JwtService);
    });
    beforeEach(() => {
        jest.clearAllMocks();
        db.user.findFirst.mockImplementation(({ where }) =>
            Promise.resolve({
                id: where.id,
                email: 'member@example.com',
                globalRole: 'USER',
                platformAuthorityVersion: 0,
            }),
        );
        db.membership.findUnique.mockResolvedValue({
            id: 'membership',
            role: 'MEMBER',
            projectPermissionsVersion: 3,
        });
        db.projectMembership.findUnique.mockResolvedValue({
            organizationId: 'org',
            role: 'VIEWER',
        });
    });
    afterAll(async () => {
        await app.close();
    });
    it.each([
        ['get', '/api/organizations/org/my-permissions'],
        ['get', '/api/organizations/org/members/member/project-permissions'],
        ['put', '/api/organizations/org/members/member/project-permissions'],
        ['get', '/api/projects/project/my-permissions'],
        ['get', '/api/projects/project/members'],
        ['get', '/api/projects/project/probe-options'],
        ['get', '/api/projects/project/notification-channel-options'],
    ] as const)(
        'rejects PATs on %s %s before business access',
        async (method, url) => {
            const token = await jwt.signAsync({
                sub: 'owner',
                globalRole: 'SUPER_ADMIN',
                kind: 'pat',
                patId: 'read-only-pat',
            });
            const response = await request(app.getHttpServer())
                [method](url)
                .set('Authorization', `Bearer ${token}`)
                .send({
                    expectedMembershipId: 'membership',
                    expectedVersion: 3,
                    projects: [],
                });
            expect(response.status).toBe(403);
            expect(db.user.findFirst).not.toHaveBeenCalled();
            expect(db.$transaction).not.toHaveBeenCalled();
        },
    );
    it('uses current database role rather than token role in project capabilities', async () => {
        const token = await jwt.signAsync({
            sub: 'member',
            globalRole: 'SUPER_ADMIN',
        });
        const response = await request(app.getHttpServer())
            .get('/api/projects/project/my-permissions')
            .set('Authorization', `Bearer ${token}`);
        expect(response.status).toBe(200);
        expect(response.body.data.effectiveRole).toBe('VIEWER');
        expect(response.body.data.accessMode).toBe('SELECTED_PROJECTS');
        expect(response.body.data.capabilities['task.write']).toBe(false);
    });
    it('returns 404 when project authorization was revoked', async () => {
        db.projectMembership.findUnique.mockResolvedValue(null);
        const token = await jwt.signAsync({
            sub: 'member',
            globalRole: 'USER',
        });
        const response = await request(app.getHttpServer())
            .get('/api/projects/project/my-permissions')
            .set('Authorization', `Bearer ${token}`);
        expect(response.status).toBe(404);
    });
    it('rejects omitted preconditions and unknown request fields before any transaction', async () => {
        const token = await jwt.signAsync({ sub: 'owner', globalRole: 'USER' });
        for (const body of [
            { projects: [] },
            {
                expectedMembershipId: 'membership',
                expectedVersion: 3,
                projects: [],
                type: 'SYSTEM',
            },
            {
                expectedMembershipId: 'membership',
                expectedVersion: 3,
                projects: [
                    {
                        projectId: 'project',
                        role: 'ADMIN',
                        organizationId: 'other',
                    },
                ],
            },
        ]) {
            const response = await request(app.getHttpServer())
                .put(
                    '/api/organizations/org/members/member/project-permissions',
                )
                .set('Authorization', `Bearer ${token}`)
                .send(body);
            expect(response.status).toBe(400);
        }
        expect(db.$transaction).not.toHaveBeenCalled();
    });
});
