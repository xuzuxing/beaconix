import {
    Injectable,
    NotFoundException,
    ForbiddenException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service';
import { CreateCommentDto, UpdateCommentDto } from './dto';
import { CommentEntity } from './entities';
import { NotificationsService } from '../notifications/notifications.service';
import type {
    NotificationDb,
    NotificationEvent,
} from '../notifications/notification-event';

const authorSelect = {
    id: true,
    name: true,
    email: true,
    avatarUrl: true,
} as const;

@Injectable()
export class CommentsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationsService: NotificationsService,
    ) {}

    async findAll(taskId: string) {
        await this.ensureTaskExists(taskId);

        // Fetch top-level comments with one level of replies (threaded)
        const comments = await this.prisma.comment.findMany({
            where: { taskId, parentId: null, deletedAt: null },
            include: {
                author: { select: authorSelect },
                replies: {
                    where: { deletedAt: null },
                    include: {
                        author: { select: authorSelect },
                    },
                    orderBy: { createdAt: 'asc' },
                },
            },
            orderBy: { createdAt: 'asc' },
        });

        return comments.map((c) => this.toEntity(c));
    }

    async create(taskId: string, userId: string, dto: CreateCommentDto) {
        const task = await this.ensureTaskExists(taskId);

        const comment = await this.prisma.$transaction(async (tx) => {
            const parent = dto.parentId
                ? await tx.comment.findFirst({
                      where: { id: dto.parentId, taskId, deletedAt: null },
                  })
                : null;
            if (dto.parentId && !parent) {
                throw new BadRequestException('Parent comment not found');
            }

            const created = await tx.comment.create({
                data: {
                    body: dto.body,
                    taskId,
                    authorId: userId,
                    parentId: dto.parentId ?? null,
                },
                include: { author: { select: authorSelect } },
            });
            const mentioned = await this.findMentionedUserIds(
                dto.body,
                task.organizationId,
                userId,
                tx,
            );
            const candidates: NotificationEvent['recipients'] = [
                ...mentioned.map((id) => ({
                    userId: id,
                    type: 'MENTION' as const,
                    title: `You were mentioned on task #${task.number}`,
                })),
                ...(parent?.authorId
                    ? [
                          {
                              userId: parent.authorId,
                              type: 'COMMENT_REPLIED' as const,
                              title: `New reply to your comment on task #${task.number}`,
                          },
                      ]
                    : []),
                ...(await this.notificationsService.taskRecipients(taskId, tx)),
            ];
            // First match wins: mention, reply author, then ordinary participants.
            const recipients = new Map<
                string,
                NotificationEvent['recipients'][number]
            >();
            for (const recipient of candidates) {
                const id =
                    typeof recipient === 'string'
                        ? recipient
                        : recipient.userId;
                if (id !== userId && !recipients.has(id))
                    recipients.set(id, recipient);
            }
            await this.notificationsService.publish(
                {
                    eventKey: `comment:${created.id}:created`,
                    type: 'TASK_COMMENTED',
                    title: `New comment on task #${task.number}`,
                    body: dto.body.replace(/\s+/g, ' ').trim().slice(0, 100),
                    organizationId: task.organizationId,
                    actorId: userId,
                    resourceType: 'Task',
                    resourceId: taskId,
                    meta: {
                        commentId: created.id,
                        parentId: dto.parentId ?? null,
                    },
                    recipients: [...recipients.values()],
                },
                tx,
            );
            return created;
        });

        return new CommentEntity(comment);
    }

    async update(
        taskId: string,
        commentId: string,
        userId: string,
        dto: UpdateCommentDto,
    ) {
        const comment = await this.findCommentOrFail(taskId, commentId);

        if (comment.authorId !== userId) {
            throw new ForbiddenException('You can only edit your own comments');
        }

        const updated = await this.prisma.comment.update({
            where: { id: commentId },
            data: {
                body: dto.body,
                isEdited: true,
            },
            include: {
                author: { select: authorSelect },
            },
        });

        return new CommentEntity(updated);
    }

    async softDelete(
        taskId: string,
        commentId: string,
        userId: string,
        userRole: string,
    ) {
        const comment = await this.findCommentOrFail(taskId, commentId);

        // Author or ADMIN+ can delete
        const isAdmin = ['OWNER', 'ADMIN'].includes(userRole);
        if (comment.authorId !== userId && !isAdmin) {
            throw new ForbiddenException(
                'You can only delete your own comments or be an admin',
            );
        }

        await this.prisma.comment.update({
            where: { id: commentId },
            data: { deletedAt: new Date() },
        });
    }

    // ── PRIVATE HELPERS ─────────────────────────────────────────────────

    /**
     * Resolve `@display name` mentions to organization members of the task's
     * project. Matching is case-insensitive, the mention must not be preceded
     * or followed by another word character (`foo@Ann.com` is not a mention,
     * `@Ann` does not match `@Anna`). The comment author is never notified
     * about mentioning themselves.
     */
    private async findMentionedUserIds(
        body: string,
        organizationId: string,
        authorId: string,
        tx: NotificationDb,
    ): Promise<string[]> {
        if (!body.includes('@')) return [];

        const members = await tx.membership.findMany({
            where: { organizationId },
            select: { userId: true, user: { select: { name: true } } },
        });

        const mentioned: string[] = [];

        for (const member of members) {
            if (member.userId === authorId) continue;

            const name = member.user.name?.trim();
            if (!name) continue;

            if (this.mentionsName(body, name)) {
                mentioned.push(member.userId);
            }
        }

        return mentioned;
    }

    private mentionsName(body: string, name: string): boolean {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(
            `(?:^|[^\\p{L}\\p{N}_])@${escaped}(?![\\p{L}\\p{N}_])`,
            'iu',
        ).test(body);
    }

    private async ensureTaskExists(taskId: string) {
        const task = await this.prisma.task.findFirst({
            where: { id: taskId, deletedAt: null },
        });
        if (!task) throw new NotFoundException('Task not found');
        return task;
    }

    private async findCommentOrFail(taskId: string, commentId: string) {
        const comment = await this.prisma.comment.findFirst({
            where: { id: commentId, taskId, deletedAt: null },
        });
        if (!comment) throw new NotFoundException('Comment not found');
        return comment;
    }

    private toEntity(comment: any): CommentEntity {
        const entity = new CommentEntity(comment);
        if (comment.replies) {
            entity.replies = comment.replies.map(
                (r: any) => new CommentEntity(r),
            );
        }
        return entity;
    }
}
