import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { QueryAuditLogsDto } from '../../../audit-logs/dto';
import { IsCuid } from '../../../../common/decorators/is-cuid.decorator';

/**
 * Cross-tenant variant used by the admin surface only.
 *
 * The tenant-scoped `QueryAuditLogsDto` deliberately has no `organizationId`:
 * there it would let a tenant member widen the scope to another organization
 * (the path `orgId` is the single source of truth). `SUPER_ADMIN` may narrow the
 * query to one organization, which is this field's only legitimate use.
 */
export class QueryAdminAuditLogsDto extends QueryAuditLogsDto {
    @ApiPropertyOptional({ description: 'Filter by organization ID' })
    @IsOptional()
    @IsCuid()
    organizationId?: string;
}
