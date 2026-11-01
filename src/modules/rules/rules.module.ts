import { Module } from '@nestjs/common';
import { RuleEvaluationModule } from './rule-evaluation.module';
import { RuleGroupsService } from './rule-groups.service';
import { RuleBindingsService } from './rule-bindings.service';
import { RuleGroupsController } from './rule-groups.controller';
import { RuleBindingsController } from './rule-bindings.controller';
import { RuleMetaController } from './rule-meta.controller';
import { AuthorizationModule } from '../../common/authorization/authorization.module';

@Module({
    imports: [AuthorizationModule, RuleEvaluationModule],
    controllers: [
        RuleGroupsController,
        RuleBindingsController,
        RuleMetaController,
    ],
    providers: [RuleGroupsService, RuleBindingsService],
    exports: [RuleEvaluationModule, RuleGroupsService, RuleBindingsService],
})
export class RulesModule {}
