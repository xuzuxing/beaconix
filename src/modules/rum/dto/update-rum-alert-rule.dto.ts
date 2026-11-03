import { PartialType } from '@nestjs/swagger';
import { CreateRumAlertRuleDto } from './create-rum-alert-rule.dto';

export class UpdateRumAlertRuleDto extends PartialType(CreateRumAlertRuleDto) {}
