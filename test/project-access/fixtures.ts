import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../src/infra/database/prisma.service';
import { ProjectAccessService } from '../../src/common/authorization/project-access.service';
import { ProjectPermissionsService } from '../../src/modules/memberships/project-permissions.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { NotificationAccessService } from '../../src/modules/notifications/notification-access.service';
import type { NotificationDeliveryService } from '../../src/modules/notifications/notification-delivery.service';
import type { NotificationStreamService } from '../../src/modules/notifications/notification-stream.service';
import { TasksService } from '../../src/modules/tasks/tasks.service';
import { CommentsService } from '../../src/modules/comments/comments.service';
import { SprintsService } from '../../src/modules/sprints/sprints.service';
import { LabelsService } from '../../src/modules/labels/labels.service';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import type { StorageService } from '../../src/modules/attachments/storage/storage.service';
import {
    buildPublicObjectKey,
    buildPrivateObjectKey,
} from '../../src/modules/attachments/storage/filename.util';
import type { PutObjectInput } from '../../src/modules/attachments/storage/storage.types';
import type { SqlDatabase } from './harness';

export function businessServices(prisma: PrismaService) {
    const access = new ProjectAccessService(prisma);
    const authorization = new NotificationAccessService(prisma, access);
    // Only external dispatch is disabled: audience checks and outbox writes
    // use the genuine services and the same PostgreSQL transaction.
    const notifications = new NotificationsService(
        prisma,
        { kick() {} } as NotificationDeliveryService,
        {} as NotificationStreamService,
        authorization,
        access,
    );
    const settings = new SettingsService(prisma);
    const deletedObjects: string[] = [];
    const storageBoundary = {
        putObject(input: PutObjectInput) {
            return Promise.resolve({
                provider: 'LOCAL' as const,
                key: buildPublicObjectKey({
                    ...input,
                    objectId: randomUUID(),
                }),
                url: '',
            });
        },
        deleteObject(_provider: string, key: string) {
            deletedObjects.push(key);
            return Promise.resolve();
        },
        getDownload() {
            return Promise.resolve({
                type: 'redirect' as const,
                url: 'https://storage.example.invalid/short-lived-test-object',
            });
        },
    };
    return {
        access,
        authorization,
        notifications,
        settings,
        deletedObjects,
        permissions: new ProjectPermissionsService(prisma, access),
        tasks: new TasksService(prisma, notifications, access),
        comments: new CommentsService(prisma, notifications, access),
        sprints: new SprintsService(prisma, notifications, access),
        labels: new LabelsService(prisma, access),
        attachments: new AttachmentsService(
            prisma,
            storageBoundary as unknown as StorageService,
            settings,
            access,
            { verifyAsync: () => Promise.reject(new Error('unused')) } as never,
            { toObjectUrl: () => Promise.resolve('') } as never,
        ),
    };
}

export async function seedAccessFixture(db: PrismaService) {
    const run = randomUUID();
    const user = (name: string, globalRole: 'USER' | 'SUPER_ADMIN' = 'USER') =>
        db.user.create({
            data: {
                email: `${name}-${run}@example.invalid`,
                password: 'not-a-login-password',
                name,
                globalRole,
                emailVerified: true,
            },
        });
    const owner = await user('owner');
    const member = await user('member');
    const viewer = await user('viewer');
    const ungranted = await user('ungranted');
    const assignee = await user('assignee');
    const platform = await user('platform', 'SUPER_ADMIN');
    const org = await db.organization.create({
        data: { name: 'O1', slug: `o1-${run}`, ownerId: owner.id },
    });
    const otherOrg = await db.organization.create({
        data: { name: 'O2', slug: `o2-${run}`, ownerId: owner.id },
    });
    const membership = (
        userId: string,
        role: 'OWNER' | 'MEMBER' | 'VIEWER',
        organizationId = org.id,
    ) => db.membership.create({ data: { userId, role, organizationId } });
    const ownerMembership = await membership(owner.id, 'OWNER');
    const memberMembership = await membership(member.id, 'MEMBER');
    const viewerMembership = await membership(viewer.id, 'VIEWER');
    const ungrantedMembership = await membership(ungranted.id, 'MEMBER');
    const assigneeMembership = await membership(assignee.id, 'MEMBER');
    await membership(owner.id, 'OWNER', otherOrg.id);
    const project = (key: string, organizationId = org.id) =>
        db.project.create({
            data: {
                name: key,
                key,
                organizationId,
                createdById: owner.id,
            },
        });
    const a = await project('A');
    const b = await project('B');
    const c = await project('C');
    const x = await project('X', otherOrg.id);
    await db.projectMembership.createMany({
        data: [
            {
                membershipId: memberMembership.id,
                projectId: a.id,
                role: 'VIEWER',
                organizationId: org.id,
            },
            {
                membershipId: memberMembership.id,
                projectId: b.id,
                role: 'ADMIN',
                organizationId: org.id,
            },
            {
                membershipId: viewerMembership.id,
                projectId: a.id,
                role: 'ADMIN',
                organizationId: org.id,
            },
            {
                membershipId: assigneeMembership.id,
                projectId: b.id,
                role: 'MEMBER',
                organizationId: org.id,
            },
        ],
    });
    const task = (projectId: string, organizationId = org.id) =>
        db.task.create({
            data: {
                title: 'Acceptance task',
                number: 1,
                projectId,
                organizationId,
                createdById: owner.id,
            },
        });
    const taskA = await task(a.id);
    const taskB = await task(b.id);
    const taskC = await task(c.id);
    const taskX = await task(x.id, otherOrg.id);
    const sprintA = await db.sprint.create({
        data: { name: 'Sprint A', projectId: a.id },
    });
    const sprintB = await db.sprint.create({
        data: { name: 'Sprint B', projectId: b.id },
    });
    const labelA = await db.label.create({
        data: {
            name: 'Label A',
            color: '#123456',
            projectId: a.id,
            organizationId: org.id,
        },
    });
    const labelB = await db.label.create({
        data: {
            name: 'Label B',
            color: '#123456',
            projectId: b.id,
            organizationId: org.id,
        },
    });
    const commentB = await db.comment.create({
        data: { body: 'Other author', taskId: taskB.id, authorId: owner.id },
    });
    const attachmentB = await db.attachment.create({
        data: {
            filename: 'private.txt',
            mimeType: 'text/plain',
            size: 4,
            url: `/api/tasks/${taskB.id}/attachments/private/download`,
            fileKey: buildPrivateObjectKey({
                organizationId: org.id,
                taskId: taskB.id,
                objectId: randomUUID(),
                filename: 'private.txt',
            }),
            source: 'UPLOAD',
            visibility: 'PRIVATE',
            storageProvider: 'LOCAL',
            taskId: taskB.id,
            uploadedById: owner.id,
        },
    });
    const unknownAttachment = await db.attachment.create({
        data: {
            filename: 'unknown.txt',
            mimeType: 'text/plain',
            size: 4,
            url: 'https://old-public.example.invalid/file',
            taskId: taskB.id,
            uploadedById: owner.id,
        },
    });
    return {
        run,
        owner,
        member,
        viewer,
        ungranted,
        assignee,
        platform,
        org,
        otherOrg,
        ownerMembership,
        memberMembership,
        viewerMembership,
        ungrantedMembership,
        assigneeMembership,
        a,
        b,
        c,
        x,
        taskA,
        taskB,
        taskC,
        taskX,
        sprintA,
        sprintB,
        labelA,
        labelB,
        commentB,
        attachmentB,
        unknownAttachment,
    };
}

export async function seedLegacyFixture(sql: SqlDatabase) {
    for (const [id, role] of [
        ['legacy-owner', 'OWNER'],
        ['legacy-member', 'MEMBER'],
        ['legacy-viewer', 'VIEWER'],
    ]) {
        await sql.query(
            'INSERT INTO users(id,email,password,name,"updatedAt") VALUES ($1,$2,$3,$1,CURRENT_TIMESTAMP)',
            [id, `${id}@example.invalid`, 'not-a-login-password'],
        );
        if (role === 'OWNER') {
            await sql.query(
                'INSERT INTO organizations(id,name,slug,"ownerId","updatedAt") VALUES ($1,$1,$1,$2,CURRENT_TIMESTAMP)',
                ['legacy-org', id],
            );
        }
        await sql.query(
            'INSERT INTO memberships(id,"userId","organizationId",role,"updatedAt") VALUES ($1,$2,$3,$4::"MembershipRole",CURRENT_TIMESTAMP)',
            [`${id}-membership`, id, 'legacy-org', role],
        );
    }
    await sql.query(
        'INSERT INTO projects(id,name,key,"organizationId","updatedAt") VALUES ($1,$1,$2,$3,CURRENT_TIMESTAMP)',
        ['legacy-project', 'LEGACY', 'legacy-org'],
    );
    await sql.query(
        'INSERT INTO tasks(id,number,title,"organizationId","projectId","updatedAt") VALUES ($1,1,$1,$2,$3,CURRENT_TIMESTAMP)',
        ['legacy-task', 'legacy-org', 'legacy-project'],
    );
    await sql.query(
        'INSERT INTO invitations(id,email,"organizationId",token,"expiresAt","sentById","updatedAt") VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP + INTERVAL \'1 day\',$5,CURRENT_TIMESTAMP)',
        [
            'legacy-invitation',
            'invitee@example.invalid',
            'legacy-org',
            'legacy-token',
            'legacy-owner',
        ],
    );
    await sql.query(
        'INSERT INTO notifications(id,"userId",type,title) VALUES ($1,$2,\'TASK_ASSIGNED\',$3)',
        ['legacy-notification', 'legacy-member', 'Legacy private task event'],
    );
    await sql.query(
        'INSERT INTO attachments(id,filename,"mimeType",size,url,"taskId","uploadedById") VALUES ($1,$2,$3,4,$4,$5,$6)',
        [
            'legacy-attachment',
            'legacy.txt',
            'text/plain',
            'https://old-public.example.invalid/private',
            'legacy-task',
            'legacy-member',
        ],
    );
}
