import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../../../infra/database/prisma.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { OrgMemberGuard } from '../../../common/guards/org-member.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { MonitorCapacityController } from './monitor-capacity.controller';
import { BillingMonitorCapacityService } from './monitor-capacity.service';

describe('monitor capacity HTTP authorization and validation', () => {
    let app: INestApplication;
    const org = 'cmg0000000000000000000001';
    const cycle = 'cmg0000000000000000000002';
    const monitor = 'cmg0000000000000000000003';
    const jwt = new JwtService({ secret: 'capacity-http-test-secret' });
    const db = {
        user: { findFirst: jest.fn() },
        organization: { findFirst: jest.fn() },
        membership: { findUnique: jest.fn() },
    };
    const service = { get: jest.fn(), select: jest.fn() };
    const path = `/api/organizations/${org}/subscription/monitor-capacity`;
    const token = jwt.sign({ sub: 'user' });

    beforeAll(async () => {
        const module = await Test.createTestingModule({
            controllers: [MonitorCapacityController],
            providers: [
                { provide: PrismaService, useValue: db },
                { provide: JwtService, useValue: jwt },
                { provide: BillingMonitorCapacityService, useValue: service },
                { provide: APP_GUARD, useClass: JwtAuthGuard },
                OrgMemberGuard,
                RolesGuard,
            ],
        }).compile();
        app = module.createNestApplication();
        app.setGlobalPrefix('api');
        app.useGlobalPipes(
            new ValidationPipe({
                whitelist: true,
                forbidNonWhitelisted: true,
                transform: true,
            }),
        );
        await app.init();
    });
    beforeEach(() => {
        jest.clearAllMocks();
        db.user.findFirst.mockResolvedValue({
            id: 'user',
            email: 'user@example.test',
            globalRole: 'USER',
        });
        db.organization.findFirst.mockResolvedValue({ id: org });
        db.membership.findUnique.mockResolvedValue({ role: 'ADMIN' });
        service.get.mockResolvedValue({ cycleId: cycle });
        service.select.mockResolvedValue({
            cycleId: cycle,
            retainedMonitorIds: [monitor],
        });
    });
    afterAll(async () => app.close());

    it('requires JWT and current organization admin access', async () => {
        await request(app.getHttpServer()).get(path).expect(401);
        for (const role of ['MEMBER', 'VIEWER']) {
            db.membership.findUnique.mockResolvedValue({ role });
            await request(app.getHttpServer())
                .get(path)
                .auth(token, { type: 'bearer' })
                .expect(403);
            await request(app.getHttpServer())
                .patch(path)
                .auth(token, { type: 'bearer' })
                .send({ cycleId: cycle, monitorIds: [monitor] })
                .expect(403);
        }
        db.membership.findUnique.mockResolvedValue(null);
        await request(app.getHttpServer())
            .get(path)
            .auth(token, { type: 'bearer' })
            .expect(403);
        expect(service.get).not.toHaveBeenCalled();
        expect(service.select).not.toHaveBeenCalled();
    });

    it('accepts administrator choices and rejects malformed/duplicate IDs and unknown fields', async () => {
        await request(app.getHttpServer())
            .get(path)
            .auth(token, { type: 'bearer' })
            .expect(200);
        await request(app.getHttpServer())
            .patch(path)
            .auth(token, { type: 'bearer' })
            .send({ cycleId: cycle, monitorIds: [monitor] })
            .expect(200);
        for (const body of [
            { cycleId: 'invalid', monitorIds: [monitor] },
            { cycleId: cycle, monitorIds: ['invalid'] },
            { cycleId: cycle, monitorIds: [monitor, monitor] },
            { cycleId: cycle, monitorIds: [monitor], organizationId: 'other' },
        ]) {
            await request(app.getHttpServer())
                .patch(path)
                .auth(token, { type: 'bearer' })
                .send(body)
                .expect(400);
        }
        expect(service.select).toHaveBeenCalledTimes(1);
        expect(service.select).toHaveBeenCalledWith(
            org,
            expect.objectContaining({ sub: 'user' }),
            { cycleId: cycle, monitorIds: [monitor] },
        );
    });
});
