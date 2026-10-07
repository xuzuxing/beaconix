import { Module } from '@nestjs/common';
import { RuleEvaluatorService } from './rule-evaluator.service';
import { RuleGroupsService } from './rule-groups.service';
import { RuleBindingsService } from './rule-bindings.service';
import { RuleGroupsController } from './rule-groups.controller';
import { RuleBindingsController } from './rule-bindings.controller';
import { RuleMetaController } from './rule-meta.controller';

@Module({
    controllers: [
        RuleGroupsController,
        RuleBindingsController,
        RuleMetaController,
    ],
    providers: [RuleEvaluatorService, RuleGroupsService, RuleBindingsService],
    exports: [RuleEvaluatorService, RuleGroupsService, RuleBindingsService],
})
export class RulesModule {}
