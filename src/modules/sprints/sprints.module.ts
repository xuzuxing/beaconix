import { Module } from '@nestjs/common';
import { SprintsController } from './sprints.controller';
import { SprintsService } from './sprints.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthorizationModule } from '../../common/authorization/authorization.module';

@Module({
    imports: [NotificationsModule, AuthorizationModule],
    controllers: [SprintsController],
    providers: [SprintsService],
    exports: [SprintsService],
})
export class SprintsModule {}
