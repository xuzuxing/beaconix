import type { ProjectAccess } from '../../common/authorization/access.types';
import { allowsProjectAction } from '../../common/authorization/project-policy';

function access(
    effectiveRole: ProjectAccess['effectiveRole'],
    projectStatus: ProjectAccess['projectStatus'] = 'ACTIVE',
): ProjectAccess {
    return {
        principal: { type: 'USER', userId: 'user-1' },
        organizationId: 'org-1',
        projectId: 'project-1',
        globalRole: null,
        organizationRole: 'MEMBER',
        membershipId: 'membership-1',
        projectPermissionsVersion: 0,
        platformAuthorityVersion: 0,
        accessMode: 'SELECTED_PROJECTS',
        canManageOrganization: false,
        canGrantOrganizationAdmin: false,
        projectStatus,
        assignedRole: effectiveRole,
        effectiveRole,
    };
}

describe('RUM project authorization policy', () => {
    it('allows project viewers to read apps and RUM history', () => {
        expect(allowsProjectAction(access('VIEWER'), 'app.read')).toBe(true);
        expect(allowsProjectAction(access('VIEWER'), 'rum.read')).toBe(true);
        expect(allowsProjectAction(access('VIEWER'), 'app.manage')).toBe(false);
    });

    it('requires ADMIN to manage apps and makes archived projects read-only', () => {
        expect(allowsProjectAction(access('ADMIN'), 'app.manage')).toBe(true);
        expect(
            allowsProjectAction(access('ADMIN', 'ARCHIVED'), 'app.manage'),
        ).toBe(false);
        expect(
            allowsProjectAction(access('VIEWER', 'ARCHIVED'), 'rum.read'),
        ).toBe(true);
    });
});
