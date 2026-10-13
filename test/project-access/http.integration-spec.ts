import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
    acceptanceCase,
    aclMigration,
    addMigrations,
    connectPrisma,
    deployLegacyBaseline,
    deployMigrations,
    HarnessFailure,
    openProjectAccessDatabases,
    removeStagedMigrations,
    safeAcceptance,
    stageLegacyMigrations,
} from './harness';
import { seedAccessFixture } from './fixtures';
import { createHttpFixture } from './http-fixture';
import { hashToken } from '../../src/modules/developer-api/common/credentials.util';

void test(
    'project ACL real PostgreSQL-backed Nest HTTP acceptance',
    {
        timeout: 240_000,
    },
    async (t) => {
        process.env.NODE_ENV = 'test';
        // The database suite may already have populated fresh/upgrade. HTTP owns
        // only its distinct database and must preflight it before any DDL.
        const harness = await openProjectAccessDatabases(['http']);
        const sql = harness.get('http');
        let directory: string | undefined;
        let handle: Awaited<ReturnType<typeof connectPrisma>> | undefined;
        let http: Awaited<ReturnType<typeof createHttpFixture>> | undefined;
        let teardownFailed: boolean;
        try {
            await safeAcceptance('HTTP schema bootstrap', async () => {
                directory = await stageLegacyMigrations();
                await deployLegacyBaseline(sql.database, directory);
                await addMigrations(directory, [aclMigration]);
                await deployMigrations(sql.database, directory);
                handle = await connectPrisma(sql.database);
                http = await createHttpFixture(handle, sql.database);
            });
            const db = handle!.prisma;
            const app = http!.app;
            const jwt = http!.jwt;
            // Fixtures use the exact PrismaService already verified in every
            // HTTP business service, never a separately configured root client.
            const f = await safeAcceptance('HTTP fixtures', () =>
                seedAccessFixture(db),
            );
            const token = (userId: string) =>
                jwt.sign({ sub: userId, globalRole: 'SUPER_ADMIN' });
            const memberToken = token(f.member.id);
            const ownerToken = token(f.owner.id);
            const viewerToken = token(f.viewer.id);
            const get = (path: string, bearer = memberToken) =>
                request(app.getHttpServer())
                    .get(`/api${path}`)
                    .set('Authorization', `Bearer ${bearer}`);
            const tasks = (projectId: string, taskId?: string) =>
                `/projects/${projectId}/tasks${taskId ? `/${taskId}` : ''}`;
            const counts = () =>
                Promise.all([
                    db.task.count(),
                    db.taskWatcher.count(),
                    db.taskActivity.count(),
                    db.notification.count(),
                    db.notificationDelivery.count(),
                ]);

            await acceptanceCase(
                t,
                'real JWT guard ignores forged role snapshots and enforces A/B/C plus future projects',
                async () => {
                    assert.equal(
                        (
                            await request(app.getHttpServer()).get(
                                `/api${tasks(f.a.id)}`,
                            )
                        ).status,
                        401,
                    );
                    assert.equal((await get(tasks(f.a.id))).status, 200);
                    assert.equal((await get(tasks(f.b.id))).status, 200);
                    assert.equal((await get(tasks(f.c.id))).status, 404);
                    const future = await db.project.create({
                        data: {
                            organizationId: f.org.id,
                            name: 'Future D',
                            key: 'D',
                        },
                    });
                    assert.equal((await get(tasks(future.id))).status, 404);
                    assert.equal(
                        (await get(tasks(future.id), ownerToken)).status,
                        200,
                    );
                    assert.equal(
                        (await get(tasks(f.c.id), ownerToken)).status,
                        200,
                    );
                    const before = await counts();
                    assert.equal(
                        (
                            await request(app.getHttpServer())
                                .post(`/api${tasks(f.a.id)}`)
                                .set('Authorization', `Bearer ${memberToken}`)
                                .send({ title: 'Viewer must not write' })
                        ).status,
                        403,
                    );
                    assert.deepEqual(await counts(), before);
                    const capped = await get(
                        `/projects/${f.a.id}/my-permissions`,
                        viewerToken,
                    );
                    assert.equal(capped.status, 200);
                    assert.equal(capped.body.data.assignedRole, 'ADMIN');
                    assert.equal(capped.body.data.effectiveRole, 'VIEWER');
                },
            );

            await acceptanceCase(
                t,
                'VIEWER may subscribe but cannot edit task content or administer an organization',
                async () => {
                    const path = `/api${tasks(f.a.id, f.taskA.id)}/watch`;
                    for (const method of ['post', 'delete'] as const) {
                        assert.equal(
                            (
                                await request(app.getHttpServer())
                                    [method](path)
                                    .set(
                                        'Authorization',
                                        `Bearer ${memberToken}`,
                                    )
                            ).status,
                            204,
                        );
                    }
                    assert.equal(
                        (
                            await request(app.getHttpServer())
                                .patch(`/api${tasks(f.a.id, f.taskA.id)}`)
                                .set('Authorization', `Bearer ${viewerToken}`)
                                .send({ title: 'Forbidden' })
                        ).status,
                        403,
                    );
                    assert.equal(
                        (
                            await request(app.getHttpServer())
                                .post(`/api/organizations/${f.org.id}/labels`)
                                .set('Authorization', `Bearer ${memberToken}`)
                                .send({
                                    name: 'Forbidden organization label',
                                    color: '#123456',
                                })
                        ).status,
                        403,
                    );
                },
            );

            await acceptanceCase(
                t,
                'tsx DTO metadata activates real whitelist, CUID and optimistic precondition validation',
                async () => {
                    const before = await counts();
                    for (const body of [
                        { title: 'Unexpected privilege', SYSTEM: true },
                        {
                            title: 'Malformed assignee',
                            assignedToId: 'not-a-cuid',
                        },
                    ]) {
                        assert.equal(
                            (
                                await request(app.getHttpServer())
                                    .post(`/api${tasks(f.b.id)}`)
                                    .set(
                                        'Authorization',
                                        `Bearer ${memberToken}`,
                                    )
                                    .send(body)
                            ).status,
                            400,
                        );
                    }
                    assert.deepEqual(await counts(), before);
                    const result = await request(app.getHttpServer())
                        .put(
                            `/api/organizations/${f.org.id}/members/${f.member.id}/project-permissions`,
                        )
                        .set('Authorization', `Bearer ${ownerToken}`)
                        .send({ projects: [] });
                    assert.equal(result.status, 400);
                },
            );

            await acceptanceCase(
                t,
                'resource parents are bound for task, sprint, comment and attachment routes, including platform callers',
                async () => {
                    const paths = [
                        tasks(f.b.id, f.taskA.id),
                        `/projects/${f.b.id}/sprints/${f.sprintA.id}`,
                        `/tasks/${f.taskA.id}/attachments/${f.attachmentB.id}/download`,
                    ];
                    for (const bearer of [memberToken, token(f.platform.id)]) {
                        for (const path of paths)
                            assert.equal((await get(path, bearer)).status, 404);
                        assert.equal(
                            (
                                await request(app.getHttpServer())
                                    .patch(
                                        `/api/tasks/${f.taskA.id}/comments/${f.commentB.id}`,
                                    )
                                    .set('Authorization', `Bearer ${bearer}`)
                                    .send({ body: 'Parent mismatch' })
                            ).status,
                            404,
                        );
                    }
                },
            );

            await acceptanceCase(
                t,
                'foreign sprint, parent, dependency, label and unwritable assignee inputs leave no business writes',
                async () => {
                    await db.projectMembership.create({
                        data: {
                            membershipId: f.viewerMembership.id,
                            projectId: f.b.id,
                            role: 'VIEWER',
                            organizationId: f.org.id,
                        },
                    });
                    await db.user.update({
                        where: { id: f.assignee.id },
                        data: { isActive: false },
                    });
                    const before = await counts();
                    for (const body of [
                        { title: 'Foreign sprint', sprintId: f.sprintA.id },
                        { title: 'Foreign parent', parentTaskId: f.taskA.id },
                        {
                            title: 'Unwritable assignee',
                            assignedToId: f.ungranted.id,
                        },
                        { title: 'Viewer assignee', assignedToId: f.viewer.id },
                        {
                            title: 'Inactive assignee',
                            assignedToId: f.assignee.id,
                        },
                    ]) {
                        assert.equal(
                            (
                                await request(app.getHttpServer())
                                    .post(`/api${tasks(f.b.id)}`)
                                    .set(
                                        'Authorization',
                                        `Bearer ${memberToken}`,
                                    )
                                    .send(body)
                            ).status,
                            400,
                        );
                    }
                    assert.equal(
                        (
                            await request(app.getHttpServer())
                                .post(
                                    `/api${tasks(f.b.id, f.taskB.id)}/dependencies`,
                                )
                                .set('Authorization', `Bearer ${memberToken}`)
                                .send({ dependencyTaskId: f.taskA.id })
                        ).status,
                        400,
                    );
                    assert.equal(
                        (
                            await request(app.getHttpServer())
                                .post(
                                    `/api/tasks/${f.taskB.id}/labels/${f.labelA.id}`,
                                )
                                .set('Authorization', `Bearer ${memberToken}`)
                        ).status,
                        400,
                    );
                    assert.deepEqual(await counts(), before);
                    await db.user.update({
                        where: { id: f.assignee.id },
                        data: { isActive: true },
                    });
                },
            );

            await acceptanceCase(
                t,
                'project ADMIN performs real task, assignee, sprint and label writes without organization ADMIN',
                async () => {
                    const created = await request(app.getHttpServer())
                        .post(`/api${tasks(f.b.id)}`)
                        .set('Authorization', `Bearer ${memberToken}`)
                        .send({
                            title: 'Local admin task',
                            assignedToId: f.assignee.id,
                        });
                    assert.equal(created.status, 201);
                    assert.equal(created.body.data.assignedToId, f.assignee.id);
                    assert.equal(
                        await db.taskWatcher.count({
                            where: { taskId: created.body.data.id },
                        }),
                        2,
                    );
                    assert.ok(
                        await db.notification.count({
                            where: {
                                userId: f.assignee.id,
                                projectId: f.b.id,
                                accessScope: 'PROJECT',
                            },
                        }),
                    );
                    assert.ok(await db.notificationDelivery.count());
                    assert.equal(
                        (
                            await request(app.getHttpServer())
                                .post(`/api/projects/${f.b.id}/sprints`)
                                .set('Authorization', `Bearer ${memberToken}`)
                                .send({ name: 'Local admin sprint' })
                        ).status,
                        201,
                    );
                    assert.equal(
                        (
                            await request(app.getHttpServer())
                                .post(`/api/projects/${f.b.id}/labels`)
                                .set('Authorization', `Bearer ${memberToken}`)
                                .send({
                                    name: 'Local admin label',
                                    color: '#123456',
                                })
                        ).status,
                        201,
                    );
                    const members = await get(`/projects/${f.b.id}/members`);
                    assert.equal(members.status, 200);
                    for (const member of members.body.data) {
                        assert.deepEqual(Object.keys(member).sort(), [
                            'avatarUrl',
                            'effectiveRole',
                            'id',
                            'name',
                        ]);
                    }
                },
            );

            await acceptanceCase(
                t,
                'database-legal legacy cross-links do not leak nested rows or inflate scoped counts',
                async () => {
                    const foreign = await db.task.create({
                        data: {
                            organizationId: f.org.id,
                            projectId: f.c.id,
                            number: 2,
                            title: 'FOREIGN_TASK_SENTINEL',
                            parentTaskId: f.taskA.id,
                        },
                    });
                    await db.task.create({
                        data: {
                            organizationId: f.org.id,
                            projectId: f.a.id,
                            number: 2,
                            title: 'DELETED_TASK_SENTINEL',
                            parentTaskId: f.taskA.id,
                            deletedAt: new Date(),
                        },
                    });
                    const valid = await db.task.create({
                        data: {
                            organizationId: f.org.id,
                            projectId: f.a.id,
                            number: 3,
                            title: 'Allowed child',
                            parentTaskId: f.taskA.id,
                        },
                    });
                    await db.taskDependency.create({
                        data: {
                            dependentTaskId: f.taskA.id,
                            dependencyTaskId: foreign.id,
                        },
                    });
                    await db.comment.create({
                        data: {
                            taskId: f.taskC.id,
                            parentId: f.commentB.id,
                            authorId: f.owner.id,
                            body: 'FOREIGN_REPLY_SENTINEL',
                        },
                    });
                    await db.taskLabel.create({
                        data: { taskId: f.taskC.id, labelId: f.labelB.id },
                    });
                    const detail = await get(tasks(f.a.id, f.taskA.id));
                    assert.equal(detail.status, 200);
                    assert.deepEqual(
                        detail.body.data.subTasks.map(
                            (task: { id: string }) => task.id,
                        ),
                        [valid.id],
                    );
                    assert.equal(detail.body.data._count.subTasks, 1);
                    assert.deepEqual(detail.body.data.dependencies, []);
                    for (const path of [
                        tasks(f.a.id),
                        `${tasks(f.a.id)}/backlog`,
                    ]) {
                        const result = await get(path);
                        assert.equal(result.status, 200);
                        assert.ok(
                            !JSON.stringify(result.body).includes(
                                'FOREIGN_TASK_SENTINEL',
                            ),
                        );
                        assert.ok(
                            !JSON.stringify(result.body).includes(
                                'DELETED_TASK_SENTINEL',
                            ),
                        );
                    }
                    const comments = await get(`/tasks/${f.taskB.id}/comments`);
                    assert.equal(comments.status, 200);
                    assert.ok(
                        !JSON.stringify(comments.body).includes(
                            'FOREIGN_REPLY_SENTINEL',
                        ),
                    );
                    const labels = await get(`/projects/${f.b.id}/labels`);
                    assert.equal(labels.status, 200);
                    assert.equal(
                        labels.body.data.find(
                            (label: { id: string }) => label.id === f.labelB.id,
                        )._count.tasks,
                        0,
                    );
                },
            );

            await acceptanceCase(
                t,
                'private attachment HTTP authorization, UNKNOWN denial and transactional admin deletion',
                async () => {
                    const download = `/api/tasks/${f.taskB.id}/attachments/${f.attachmentB.id}/download`;
                    assert.equal(
                        (await request(app.getHttpServer()).get(download))
                            .status,
                        401,
                    );
                    const allowed = await request(app.getHttpServer())
                        .get(download)
                        .set('Authorization', `Bearer ${memberToken}`);
                    assert.equal(allowed.status, 302);
                    assert.equal(
                        allowed.headers['cache-control'],
                        'private, no-store',
                    );
                    assert.equal(
                        (
                            await get(
                                `/tasks/${f.taskB.id}/attachments/${f.unknownAttachment.id}/download`,
                            )
                        ).status,
                        404,
                    );
                    assert.equal(
                        (
                            await request(app.getHttpServer())
                                .post(`/api/tasks/${f.taskB.id}/attachments`)
                                .set('Authorization', `Bearer ${memberToken}`)
                                .send({
                                    filename: 'public.txt',
                                    mimeType: 'text/plain',
                                    size: 4,
                                    source: 'UPLOAD',
                                    url: 'https://public.example.invalid/file',
                                    fileKey: 'users/arbitrary/public.txt',
                                    storageProvider: 'LOCAL',
                                })
                        ).status,
                        400,
                    );
                    assert.equal(
                        (
                            await request(app.getHttpServer())
                                .patch(
                                    `/api/tasks/${f.taskB.id}/comments/${f.commentB.id}`,
                                )
                                .set('Authorization', `Bearer ${memberToken}`)
                                .send({ body: 'Cannot edit another author' })
                        ).status,
                        403,
                    );
                    assert.equal(
                        (
                            await request(app.getHttpServer())
                                .delete(
                                    `/api/tasks/${f.taskB.id}/comments/${f.commentB.id}`,
                                )
                                .set('Authorization', `Bearer ${memberToken}`)
                        ).status,
                        204,
                    );
                    assert.equal(
                        (
                            await request(app.getHttpServer())
                                .delete(
                                    `/api/tasks/${f.taskB.id}/attachments/${f.attachmentB.id}`,
                                )
                                .set('Authorization', `Bearer ${memberToken}`)
                        ).status,
                        204,
                    );
                    assert.equal(
                        await db.attachment.findUnique({
                            where: { id: f.attachmentB.id },
                        }),
                        null,
                    );
                    assert.equal(
                        await db.auditLog.count({
                            where: {
                                entity: 'Attachment',
                                entityId: f.attachmentB.id,
                            },
                        }),
                        1,
                    );
                    assert.equal(http!.services.deletedObjects.length, 1);
                },
            );

            await acceptanceCase(
                t,
                'real developer authentication combines PAT role/scope and API key organization boundaries',
                async () => {
                    for (const project of [f.a, f.b, f.c, f.x]) {
                        await db.monitor.create({
                            data: {
                                name: 'No-network fixture monitor',
                                type: 'HTTP',
                                target: 'https://example.invalid',
                                organizationId: project.organizationId,
                                projectId: project.id,
                            },
                        });
                    }
                    const pat = await db.personalAccessToken.create({
                        data: {
                            userId: f.member.id,
                            name: 'HTTP PAT',
                            tokenHash: hashToken(randomUUID()),
                            scopes: ['monitors:read', 'monitors:write'],
                        },
                    });
                    const bearer = jwt.sign({
                        sub: f.member.id,
                        globalRole: 'SUPER_ADMIN',
                        kind: 'pat',
                        patId: pat.id,
                    });
                    assert.equal(
                        (await get(tasks(f.b.id), bearer)).status,
                        403,
                    );
                    assert.equal(
                        (
                            await get(
                                `/developer/v1/projects/${f.a.id}/monitors`,
                                bearer,
                            )
                        ).status,
                        200,
                    );
                    assert.equal(
                        (
                            await get(
                                `/developer/v1/projects/${f.c.id}/monitors`,
                                bearer,
                            )
                        ).status,
                        404,
                    );
                    assert.equal(
                        (
                            await request(app.getHttpServer())
                                .post(
                                    `/api/developer/v1/projects/${f.a.id}/monitors`,
                                )
                                .set('Authorization', `Bearer ${bearer}`)
                                .send({
                                    name: 'Forbidden',
                                    type: 'HTTP',
                                    target: 'https://example.invalid',
                                })
                        ).status,
                        403,
                    );
                    const key = `bk_org_${randomUUID()}`;
                    await db.apiKey.create({
                        data: {
                            organizationId: f.org.id,
                            name: 'Machine fixture',
                            keyPrefix: key.slice(0, 12),
                            keyHash: hashToken(key),
                            scopes: ['monitors:read'],
                            createdById: f.ungranted.id,
                        },
                    });
                    assert.equal(
                        (
                            await get(
                                `/developer/v1/projects/${f.c.id}/monitors`,
                                key,
                            )
                        ).status,
                        200,
                    );
                    assert.equal(
                        (
                            await get(
                                `/developer/v1/projects/${f.x.id}/monitors`,
                                key,
                            )
                        ).status,
                        403,
                    );
                    await db.personalAccessToken.update({
                        where: { id: pat.id },
                        data: { revokedAt: new Date() },
                    });
                    assert.equal(
                        (
                            await get(
                                `/developer/v1/projects/${f.a.id}/monitors`,
                                bearer,
                            )
                        ).status,
                        401,
                    );
                },
            );

            await acceptanceCase(
                t,
                'current database identity revocation defeats old JWT snapshots',
                async () => {
                    const platformToken = token(f.platform.id);
                    assert.equal(
                        (await get(tasks(f.c.id), platformToken)).status,
                        200,
                    );
                    await db.user.update({
                        where: { id: f.platform.id },
                        data: { globalRole: 'USER' },
                    });
                    assert.equal(
                        (await get(tasks(f.c.id), platformToken)).status,
                        404,
                    );
                    await db.user.update({
                        where: { id: f.member.id },
                        data: { isActive: false },
                    });
                    assert.equal((await get(tasks(f.b.id))).status, 401);
                    await db.user.update({
                        where: { id: f.member.id },
                        data: { isActive: true },
                    });
                },
            );

            await acceptanceCase(
                t,
                'empty ACL replacement commits audit and immediately removes HTTP project access; stale preconditions fail',
                async () => {
                    const path = `/api/organizations/${f.org.id}/members/${f.member.id}/project-permissions`;
                    const current = await db.membership.findUniqueOrThrow({
                        where: { id: f.memberMembership.id },
                    });
                    const body = {
                        expectedMembershipId: current.id,
                        expectedVersion: current.projectPermissionsVersion,
                        projects: [],
                    };
                    const result = await request(app.getHttpServer())
                        .put(path)
                        .set('Authorization', `Bearer ${ownerToken}`)
                        .send(body);
                    assert.equal(result.status, 200);
                    assert.equal(
                        result.body.data.accessMode,
                        'SELECTED_PROJECTS',
                    );
                    assert.deepEqual(result.body.data.projects, []);
                    assert.equal((await get(tasks(f.b.id))).status, 404);
                    assert.equal(
                        (
                            await request(app.getHttpServer())
                                .put(path)
                                .set('Authorization', `Bearer ${ownerToken}`)
                                .send(body)
                        ).status,
                        409,
                    );
                    assert.equal(
                        await db.auditLog.count({
                            where: {
                                entity: 'ProjectPermissions',
                                entityId: current.id,
                            },
                        }),
                        1,
                    );
                },
            );
        } finally {
            const appResult = await Promise.allSettled(
                http ? [http.app.close()] : [],
            );
            const results = await Promise.allSettled([
                ...(handle ? [handle.close()] : []),
                ...(directory ? [removeStagedMigrations(directory)] : []),
                harness.close(),
            ]);
            teardownFailed = [...appResult, ...results].some(
                (result) => result.status === 'rejected',
            );
        }
        if (teardownFailed) {
            throw new HarnessFailure('Project-access HTTP teardown failed.');
        }
    },
);
