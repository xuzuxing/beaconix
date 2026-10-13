import { SetMetadata } from '@nestjs/common';
import type { ProjectAction } from './project-policy';
import type { ProjectResourceSelector } from './access.types';

export const PROJECT_PERMISSION_KEY = 'project-permission';
export interface ProjectPermissionMetadata {
    action: ProjectAction;
    resource: ProjectResourceSelector;
}

export const ProjectPermission = (
    action: ProjectAction,
    resource: ProjectResourceSelector,
) =>
    SetMetadata(PROJECT_PERMISSION_KEY, {
        action,
        resource,
    } satisfies ProjectPermissionMetadata);
