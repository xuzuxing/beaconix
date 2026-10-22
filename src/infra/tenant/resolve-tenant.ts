import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { PrismaService } from '../database/prisma.service';

/** 把解析结果挂到 request 上，供审计拦截器与后续守卫复用。 */
function stash(request: Request, key: string, value: unknown): void {
    (request as unknown as Record<string, unknown>)[key] = value;
}

/**
 * 从请求参数推断「当前请求属于哪个组织」。
 *
 * 这里刻意**不**用请求头或 JWT 声明来传租户：
 *
 * - 请求头由客户端控制，守卫就必须再校验一次「URL 里的资源属于头里的组织」，
 *   等于把反查逻辑换个地方写；两处不一致时还会形成租户混淆的攻击面。
 * - 从资源本身反推（订单/任务/项目 → organizationId）天然一致：拿到的 org
 *   一定就是资源所属的 org，不存在「头说 A、资源属于 B」的歧义。
 *
 * 代价是「新增一种参数形状就要在这里补一个分支」——所以所有形状集中在本文件，
 * 并有 `resolve-tenant.spec.ts` 逐形状覆盖；新增资源类型时补分支 + 补测试。
 *
 * 写成接收 `prisma` 的自由函数（而不是可注入的 provider）：守卫会被任意业务
 * 模块通过 `@UseGuards(...)` 引用，若做成 provider 就必须为它单独注册一个
 * 全局模块，只为转发一个纯查询不值得。
 *
 * 解析顺序（先命中先返回）：
 * `:orgId` → `:projectId` → `:taskId` → 通用 `:id`（organization / label / order）
 */
export async function resolveTenant(
    prisma: PrismaService,
    request: Request,
): Promise<string | undefined> {
    const params = (request.params ?? {}) as Record<string, string | undefined>;

    const orgId = params['orgId'];
    if (orgId) return orgId;

    const projectId = params['projectId'];
    if (projectId) return fromProject(prisma, request, projectId);

    const taskId = params['taskId'];
    if (taskId) return fromTask(prisma, request, taskId);

    const id = params['id'];
    if (id) return fromGenericId(prisma, request, id);

    return undefined;
}

/** 形如 `/projects/:projectId/...` 的路由。 */
async function fromProject(
    prisma: PrismaService,
    request: Request,
    projectId: string,
): Promise<string> {
    const project = await prisma.project.findFirst({
        where: { id: projectId, deletedAt: null },
        select: { organizationId: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    // Verify org is not soft-deleted
    const org = await prisma.organization.findFirst({
        where: { id: project.organizationId, deletedAt: null },
        select: { id: true },
    });
    if (!org) throw new NotFoundException('Organization not found');

    stash(request, 'projectOrgId', project.organizationId);

    return project.organizationId;
}

/** 形如 `/tasks/:taskId/...` 的路由。 */
async function fromTask(
    prisma: PrismaService,
    request: Request,
    taskId: string,
): Promise<string> {
    const task = await prisma.task.findFirst({
        where: { id: taskId, deletedAt: null },
        select: { organizationId: true, projectId: true },
    });
    if (!task) throw new NotFoundException('Task not found');

    const org = await prisma.organization.findFirst({
        where: { id: task.organizationId, deletedAt: null },
        select: { id: true },
    });
    if (!org) throw new NotFoundException('Organization not found');

    stash(request, 'taskOrgId', task.organizationId);
    stash(request, 'taskProjectId', task.projectId);

    return task.organizationId;
}

/**
 * 通用 `:id`：同一个参数名在不同路由里可能是组织、标签或订单。
 *
 * 按「组织 → 标签 → 订单」顺序尝试。全部未命中返回 undefined，由调用方
 * 决定如何拒绝（守卫统一回 403 `Organization context required`）。
 */
async function fromGenericId(
    prisma: PrismaService,
    request: Request,
    id: string,
): Promise<string | undefined> {
    // Check if it's an org ID
    const org = await prisma.organization.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
    });
    if (org) return id;

    // Check if it's a label ID
    const label = await prisma.label.findUnique({
        where: { id },
        select: { organizationId: true },
    });
    if (label) {
        stash(request, 'labelOrgId', label.organizationId);

        return label.organizationId;
    }

    // Check if it's an order ID (`/orders/:id`, `/orders/:id/refunds`, …)
    const order = await prisma.order.findUnique({
        where: { id },
        select: { organizationId: true },
    });
    if (order) {
        stash(request, 'orderOrgId', order.organizationId);

        return order.organizationId;
    }

    return undefined;
}
