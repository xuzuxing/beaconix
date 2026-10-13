import { Module } from '@nestjs/common';
import { ProjectAccessService } from './project-access.service';
import { ResourceContextResolver } from './resource-context.resolver';
import { ProjectAccessGuard } from './project-access.guard';

@Module({
    providers: [
        ProjectAccessService,
        ResourceContextResolver,
        ProjectAccessGuard,
    ],
    exports: [
        ProjectAccessService,
        ResourceContextResolver,
        ProjectAccessGuard,
    ],
})
export class AuthorizationModule {}
