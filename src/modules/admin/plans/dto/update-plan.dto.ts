import { PartialType } from '@nestjs/swagger';
import { CreatePlanDto } from './create-plan.dto';

/**
 * Partial plan update. Omitted fields keep their current value; `null` clears
 * `description`.
 *
 * `code` may only echo the stored value — sending anything else is rejected
 * with `400 plan code is immutable` (see `AdminPlansService.update`).
 */
export class UpdatePlanDto extends PartialType(CreatePlanDto) {}
