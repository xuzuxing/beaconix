import { Module } from '@nestjs/common';
import { RuleEvaluatorService } from './rule-evaluator.service';

/** Rule computation without management routes, authorization or background jobs. */
@Module({
    providers: [RuleEvaluatorService],
    exports: [RuleEvaluatorService],
})
export class RuleEvaluationModule {}
