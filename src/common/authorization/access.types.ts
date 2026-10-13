import type {
    GlobalRole,
    MembershipRole,
    ProjectRole,
    ProjectStatus,
} from '../../generated/prisma/enums';

const systemAuthority = Symbol('internal-system-authority');

export type AccessPrincipal =
    | { type: 'USER'; userId: string; patId?: string }
    | { type: 'API_KEY'; keyId: string; organizationId: string }
    | {
          type: 'SYSTEM';
          reason: string;
          authority: typeof systemAuthority;
      };

export function systemPrincipal(reason: string): AccessPrincipal {
    return { type: 'SYSTEM', reason, authority: systemAuthority };
}

export function isSystemPrincipal(principal: AccessPrincipal): boolean {
    return (
        principal.type === 'SYSTEM' &&
        principal.authority === systemAuthority &&
        !!principal.reason
    );
}

export interface OrganizationAccess {
    principal: AccessPrincipal;
    organizationId: string;
    globalRole: GlobalRole | null;
    organizationRole: MembershipRole | null;
    membershipId: string | null;
    projectPermissionsVersion: number | null;
    platformAuthorityVersion: number | null;
    accessMode: 'ALL_PROJECTS' | 'SELECTED_PROJECTS';
    canManageOrganization: boolean;
    canGrantOrganizationAdmin: boolean;
}

export interface ProjectAccess extends OrganizationAccess {
    projectId: string;
    projectStatus: ProjectStatus;
    assignedRole: ProjectRole | null;
    effectiveRole: ProjectRole;
}

export type ProjectResourceType =
    | 'PROJECT'
    | 'TASK'
    | 'SPRINT'
    | 'COMMENT'
    | 'ATTACHMENT'
    | 'MONITOR'
    | 'LABEL'
    | 'RULE_GROUP'
    | 'ALERT_EVENT';

export interface ProjectResourceSelector {
    resourceType: ProjectResourceType;
    idParam: string;
    projectParam?: string;
    organizationParam?: string;
    taskParam?: string;
}
