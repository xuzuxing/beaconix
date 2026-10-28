import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiExtraModels,
    ApiForbiddenResponse,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
    ApiUnauthorizedResponse,
    getSchemaPath,
} from '@nestjs/swagger';
import { SuperAdminGuard } from '../../../common/guards';
import { QueryAdminAuditLogsDto } from './dto/query-admin-audit-logs.dto';
import { AuditLogEntity } from '../../audit-logs/entities';
import { AdminAuditLogsService } from './admin-audit-logs.service';

@ApiTags('Admin / Audit Logs')
@ApiBearerAuth('access-token')
@UseGuards(SuperAdminGuard)
@ApiExtraModels(AuditLogEntity)
@Controller('admin/audit-logs')
export class AdminAuditLogsController {
    constructor(
        private readonly adminAuditLogsService: AdminAuditLogsService,
    ) {}

    @Get()
    @ApiOperation({
        summary: 'List audit logs across every tenant',
        description:
            'Cross-tenant audit log query for SUPER_ADMIN. All filters are opt-in.',
    })
    @ApiOkResponse({
        description: 'Paginated audit log entries',
        schema: {
            properties: {
                items: {
                    type: 'array',
                    items: { $ref: getSchemaPath(AuditLogEntity) },
                },
                total: { type: 'number', example: 1500 },
                page: { type: 'number', example: 1 },
                limit: { type: 'number', example: 25 },
                totalPages: { type: 'number', example: 60 },
            },
        },
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    async findAll(@Query() query: QueryAdminAuditLogsDto) {
        return this.adminAuditLogsService.findAll(query);
    }
}
