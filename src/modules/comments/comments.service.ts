import {
    Injectable,
    NotFoundException,
    ForbiddenException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateCommentDto, UpdateCommentDto } from './dto';
import { CommentEntity } from './entities';
import { NotificationsService } from '../notifications/notifications.service';

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

        if (dto.parentId) {
            const parent = await this.prisma.comment.findFirst({
                where: { id: dto.parentId, taskId, deletedAt: null },
            });
            if (!parent) {
                throw new BadRequestException('Parent comment not found');
            }
        }

        const comment = await this.prisma.comment.create({
            data: {
                body: dto.body,
                taskId,
                authorId: userId,
                parentId: dto.parentId ?? null,
            },
            include: {
                author: { select: authorSelect },
            },
        });

        // Notify task watchers and mentioned members (fire-and-forget).
        // Mentioned members get a MENTION notification instead of TASK_COMMENTED.
        const mentionedUserIds = await this.findMentionedUserIds(
            dto.body,
            task.projectId,
            userId,
        );
        const mentioned = new Set(mentionedUserIds);

        const watchers = await this.prisma.taskWatcher.findMany({
            where: { taskId },
            select: { userId: true },
        });
        const watcherIds = watchers
            .map((w) => w.userId)
            .filter((id) => id !== userId && !mentioned.has(id));

        const preview = dto.body.replace(/\s+/g, ' ').trim().slice(0, 100);

        if (watcherIds.length > 0) {
            this.notificationsService
                .createAndEmitMany(watcherIds, {
                    type: 'TASK_COMMENTED' as const,
                    title: `New comment on task #${task.number}`,
                    body: preview,
                    resourceType: 'Task',
                    resourceId: taskId,
                })
                .catch(() => {});
        }

        if (mentionedUserIds.length > 0) {
            this.notificationsService
                .createAndEmitMany(mentionedUserIds, {
                    type: 'MENTION' as const,
                    title: `You were mentioned on task #${task.number}`,
                    body: preview,
                    resourceType: 'Task',
                    resourceId: taskId,
                    meta: { commentId: comment.id },
                })
                .catch(() => {});
        }

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
        projectId: string,
        authorId: string,
    ): Promise<string[]> {
        if (!body.includes('@')) return [];

        const project = await this.prisma.project.findUnique({
            where: { id: projectId },
            select: { organizationId: true },
        });
        if (!project) return [];

        const members = await this.prisma.membership.findMany({
            where: { organizationId: project.organizationId },
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
