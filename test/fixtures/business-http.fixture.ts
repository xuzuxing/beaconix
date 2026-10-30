import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { TransformInterceptor } from '../../src/common/interceptors/transform.interceptor';

/** Identity tables only. Authorization decisions remain in the real guards/services. */
export function identityTables(org: any) {
    const membership = (userId: string, organizationId: string) =>
        organizationId === org.id && userId !== 'outsider'
            ? {
                  id: `membership-${userId}`,
                  organizationId,
                  userId,
                  role: userId === 'member' ? 'MEMBER' : 'ADMIN',
              }
            : null;
    return {
        user: {
            findFirst: jest.fn(({ where }) => ({
                id: where.id,
                email: `${where.id}@example.invalid`,
                globalRole: 'USER',
                platformAuthorityVersion: 1,
            })),
        },
        organization: {
            findFirst: jest.fn(({ where }) =>
                where.id === org.id ? org : null,
            ),
        },
        membership: {
            findUnique: jest.fn(({ where }) =>
                membership(
                    where.userId_organizationId.userId,
                    where.userId_organizationId.organizationId,
                ),
            ),
            findMany: jest.fn(({ where }) => {
                const ids =
                    typeof where.userId === 'string'
                        ? [where.userId]
                        : where.userId.in;
                return ids
                    .map((id: string) => membership(id, where.organizationId))
                    .filter(Boolean);
            }),
        },
        project: {
            findFirst: jest.fn(({ where }) =>
                where.id === 'project' &&
                (!where.organizationId || where.organizationId === org.id)
                    ? {
                          id: 'project',
                          organizationId: org.id,
                          status: 'ACTIVE',
                      }
                    : null,
            ),
        },
        projectMembership: { findUnique: jest.fn(() => null) },
    };
}

export function configureBusinessApp(app: INestApplication, db: any) {
    const jwt = new JwtService({ secret: 'offline-business-regression-only' });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
        new ValidationPipe({
            transform: true,
            whitelist: true,
            forbidNonWhitelisted: true,
        }),
    );
    app.useGlobalGuards(new JwtAuthGuard(jwt, new Reflector(), db));
    app.useGlobalInterceptors(new TransformInterceptor());
    return jwt;
}

/** Serial rollback-capable transactions; proves atomicity, never PostgreSQL locks. */
export function transactions(
    db: any,
    snapshot: () => unknown,
    restore: (saved: any) => void,
) {
    let tail = Promise.resolve();
    db.$transaction = jest.fn((work) => {
        const next = tail.then(async () => {
            const saved = structuredClone(snapshot());
            try {
                return await work(db);
            } catch (error) {
                restore(saved);
                throw error;
            }
        });
        tail = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    });
}
