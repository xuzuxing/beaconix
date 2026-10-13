import { Module } from '@nestjs/common';
import { LabelsService } from './labels.service';
import {
    OrgLabelsController,
    ProjectLabelsController,
    LabelsController,
    TaskLabelsController,
} from './labels.controller';
import { AuthorizationModule } from '../../common/authorization/authorization.module';

@Module({
    imports: [AuthorizationModule],
    controllers: [
        OrgLabelsController,
        ProjectLabelsController,
        LabelsController,
        TaskLabelsController,
    ],
    providers: [LabelsService],
    exports: [LabelsService],
})
export class LabelsModule {}
