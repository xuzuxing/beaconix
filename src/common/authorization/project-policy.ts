import type { ProjectAccess } from './access.types';

export const PROJECT_ACTIONS = {
    'project.read': { role: 'VIEWER', archived: true },
    'project.manage': { role: 'ADMIN', archived: false },
    'project.archive': { role: 'ADMIN', archived: true },
    'project.delete': { role: 'ADMIN', archived: true, organization: true },
    'project.restore': { role: 'ADMIN', archived: true, organization: true },
    'task.write': { role: 'MEMBER', archived: false },
    'task.restore': { role: 'ADMIN', archived: false },
    'task.subscribe': { role: 'VIEWER', archived: true },
    'comment.write': { role: 'MEMBER', archived: false },
    'comment.moderate': { role: 'ADMIN', archived: false },
    'attachment.write': { role: 'MEMBER', archived: false },
    'attachment.moderate': { role: 'ADMIN', archived: false },
    'sprint.manage': { role: 'ADMIN', archived: false },
    'label.manage': { role: 'ADMIN', archived: false },
    'monitor.read': { role: 'VIEWER', archived: true },
    'monitoring.read': { role: 'VIEWER', archived: true },
    'monitor.check': { role: 'MEMBER', archived: false },
    'monitor.manage': { role: 'ADMIN', archived: false },
    'monitor.restore': { role: 'ADMIN', archived: false },
    'monitor.test-alert': { role: 'ADMIN', archived: false },
    'rule.manage': { role: 'ADMIN', archived: false },
    'alert.retry': { role: 'ADMIN', archived: false },
} as const;

export type ProjectAction = keyof typeof PROJECT_ACTIONS;
const ROLE_LEVEL = { VIEWER: 1, MEMBER: 2, ADMIN: 3 } as const;

export function allowsProjectAction(
    access: ProjectAccess,
    action: ProjectAction,
): boolean {
    const policy = PROJECT_ACTIONS[action] as
        | {
              role: keyof typeof ROLE_LEVEL;
              archived: boolean;
              organization?: true;
          }
        | undefined;
    if (!policy) return false;
    if (policy.organization && !access.canManageOrganization) return false;
    if (access.projectStatus === 'ARCHIVED' && !policy.archived) return false;
    return ROLE_LEVEL[access.effectiveRole] >= ROLE_LEVEL[policy.role];
}

export function projectCapabilities(access: ProjectAccess) {
    return Object.fromEntries(
        (Object.keys(PROJECT_ACTIONS) as ProjectAction[]).map((action) => [
            action,
            allowsProjectAction(access, action),
        ]),
    ) as Record<ProjectAction, boolean>;
}
