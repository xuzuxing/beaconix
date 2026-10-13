import {
    Injectable,
    type CanActivate,
    type ExecutionContext,
    ForbiddenException,
    UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { JwtPayload } from '../interfaces/jwt-payload.interface';
import type { AccessPrincipal } from './access.types';
import { ProjectAccessService } from './project-access.service';
import { ResourceContextResolver } from './resource-context.resolver';
import {
    PROJECT_PERMISSION_KEY,
    type ProjectPermissionMetadata,
} from './project-permission.decorator';

@Injectable()
export class ProjectAccessGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly resolver: ResourceContextResolver,
        private readonly access: ProjectAccessService,
    ) {}

    async canActivate(context: ExecutionContext) {
        const permission =
            this.reflector.getAllAndOverride<ProjectPermissionMetadata>(
                PROJECT_PERMISSION_KEY,
                [context.getHandler(), context.getClass()],
            );
        if (!permission)
            throw new ForbiddenException(
                'Project permission metadata required',
            );
        const request = context.switchToHttp().getRequest<
            Request & {
                user?: JwtPayload & { kind?: string; patId?: string };
                accessPrincipal?: AccessPrincipal;
            }
        >();
        const principal =
            request.accessPrincipal ??
            (request.user
                ? {
                      type: 'USER' as const,
                      userId: request.user.sub,
                      ...(request.user.patId
                          ? { patId: request.user.patId }
                          : {}),
                  }
                : null);
        if (!principal || principal.type === 'SYSTEM')
            throw new UnauthorizedException('Authentication required');
        const resource = await this.resolver.resolve(
            request.params as Record<string, string>,
            {
                ...(request.params.projectId
                    ? { projectParam: 'projectId' }
                    : {}),
                ...(request.params.taskId ? { taskParam: 'taskId' } : {}),
                ...(request.params.orgId ? { organizationParam: 'orgId' } : {}),
                ...permission.resource,
            },
            permission.action === 'project.restore' ||
                permission.action === 'task.restore' ||
                permission.action === 'monitor.restore',
        );
        const access = await this.access.project(
            principal,
            resource.projectId,
            permission.action,
            resource.organizationId,
        );
        request['accessContext'] = access;
        request['projectOrgId'] = resource.organizationId;
        request['taskOrgId'] = resource.taskId
            ? resource.organizationId
            : undefined;
        request['taskProjectId'] = resource.taskId
            ? resource.projectId
            : undefined;
        return true;
    }
}
