import { Module } from '@nestjs/common';
import { MembershipsController } from './memberships.controller';
import { MembershipsService } from './memberships.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { ProjectPermissionsService } from './project-permissions.service';
import {
    OrganizationProjectPermissionsController,
    ProjectPermissionsController,
} from './project-permissions.controller';

@Module({
    imports: [NotificationsModule, AuthorizationModule],
    controllers: [
        MembershipsController,
        OrganizationProjectPermissionsController,
        ProjectPermissionsController,
    ],
    providers: [MembershipsService, ProjectPermissionsService],
    exports: [MembershipsService],
})
export class MembershipsModule {}
