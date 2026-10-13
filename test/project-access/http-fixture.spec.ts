import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { PrismaService } from '../../src/infra/database/prisma.service';
import { TasksController } from '../../src/modules/tasks/tasks.controller';
import { TasksService } from '../../src/modules/tasks/tasks.service';
import { CreateTaskDto } from '../../src/modules/tasks/dto/create-task.dto';
import { QueryTasksDto } from '../../src/modules/tasks/dto/query-tasks.dto';
import { OrganizationProjectPermissionsController } from '../../src/modules/memberships/project-permissions.controller';
import { ProjectAccessGuard } from '../../src/common/authorization/project-access.guard';
import { DeveloperAuthGuard } from '../../src/modules/developer-api/auth/developer-auth.guard';
import { validateProjectAccessDatabase } from './database-safety';
import { createHttpModule } from './http-fixture';

void test('tsx real controller/guard bootstrap restores injection and DTO metadata without a database or guard overrides', async () => {
    let queries = 0;
    // No lifecycle methods or delegate fallback: any accidental access fails.
    const prisma = new Proxy(
        {},
        {
            get(_target, key) {
                if (typeof key === 'string' && key.startsWith('$')) {
                    return () => {
                        queries++;
                        throw new Error(
                            'Offline fixture attempted database access',
                        );
                    };
                }
                return undefined;
            },
        },
    ) as PrismaService;
    const database = validateProjectAccessDatabase(
        'http',
        'postgresql://fixture:secret@localhost/beacon_project_access_http_test_metadata',
    );
    const { moduleRef, services } = await createHttpModule(prisma, database);
    try {
        assert.equal(
            Reflect.get(moduleRef.get(TasksController), 'tasksService'),
            services.tasks,
        );
        assert.equal(moduleRef.get(TasksService), services.tasks);
        assert.deepEqual(
            Reflect.getMetadata('design:paramtypes', TasksController),
            [TasksService],
        );
        const bodyTypes = Reflect.getMetadata(
            'design:paramtypes',
            TasksController.prototype,
            'create',
        );
        assert.equal(bodyTypes[2], CreateTaskDto);
        const queryTypes = Reflect.getMetadata(
            'design:paramtypes',
            TasksController.prototype,
            'findAll',
        );
        assert.equal(queryTypes[1], QueryTasksDto);
        const permissions = Reflect.getMetadata(
            'design:paramtypes',
            OrganizationProjectPermissionsController.prototype,
            'replace',
        );
        assert.ok(
            permissions?.some(
                (type: unknown) =>
                    typeof type === 'function' &&
                    type !== Object &&
                    type !== String,
            ),
        );

        let guards = 0;
        for (const module of moduleRef.get(ModulesContainer).values()) {
            for (const [token, wrapper] of module.injectables) {
                if (token === ProjectAccessGuard) {
                    assert.ok(wrapper.instance instanceof ProjectAccessGuard);
                    assert.equal(
                        Reflect.get(wrapper.instance, 'access'),
                        services.access,
                    );
                    assert.ok(Reflect.get(wrapper.instance, 'resolver'));
                    assert.ok(Reflect.get(wrapper.instance, 'reflector'));
                    guards++;
                }
                if (token === DeveloperAuthGuard) {
                    assert.ok(wrapper.instance instanceof DeveloperAuthGuard);
                    assert.equal(
                        Reflect.get(wrapper.instance, 'prisma'),
                        prisma,
                    );
                    assert.ok(
                        Reflect.get(wrapper.instance, 'credentialsService'),
                    );
                    assert.equal(
                        Reflect.get(wrapper.instance, 'access'),
                        services.access,
                    );
                    guards++;
                }
            }
        }
        assert.ok(guards >= 2);
        const pipe = new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        });
        for (const value of [
            { title: 'Unexpected', privilege: true },
            { title: 'Malformed', assignedToId: 'not-a-cuid' },
        ]) {
            await assert.rejects(
                pipe.transform(value, { type: 'body', metatype: bodyTypes[2] }),
                BadRequestException,
            );
        }
        const valid = await pipe.transform(
            { title: 'Allowed' },
            { type: 'body', metatype: bodyTypes[2] },
        );
        assert.ok(valid instanceof CreateTaskDto);
        assert.equal(queries, 0);
    } finally {
        await moduleRef.close();
    }
});
