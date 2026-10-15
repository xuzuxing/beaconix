import { QueryTimezoneDto } from '../../../common/dto/query-timezone.dto';

/**
 * Query parameters of the public status page.
 *
 * Only the visitor's time zone is accepted: the heatmap is a fixed 3-day
 * window, so `days` is deliberately not a parameter.
 */
export class QueryPublicStatusPageDto extends QueryTimezoneDto {}
