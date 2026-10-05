import {
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SuperAdminGuard } from '../../../common/guards';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminTenantEntity } from './entities';

@ApiTags('Admin / Tenants')
@ApiBearerAuth('access-token')
@UseGuards(SuperAdminGuard)
@Controller('admin/tenants')
export class AdminTenantsController {
    constructor(private readonly adminTenantsService: AdminTenantsService) {}

    @Get()
    @ApiOperation({ summary: 'List every tenant across the platform' })
    @ApiOkResponse({ type: [AdminTenantEntity], description: 'All tenants' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    async findAll() {
        return this.adminTenantsService.findAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one tenant by ID' })
    @ApiParam({ name: 'id', description: 'Organization UUID' })
    @ApiOkResponse({ type: AdminTenantEntity, description: 'Tenant details' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Tenant not found' })
    async findOne(@Param('id') id: string) {
        return this.adminTenantsService.findOne(id);
    }

    @Patch(':id/toggle')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Toggle a tenant active/deleted',
        description:
            'Soft-deletes the tenant when active, restores it when deleted.',
    })
    @ApiParam({ name: 'id', description: 'Organization UUID' })
    @ApiOkResponse({ type: AdminTenantEntity, description: 'Tenant updated' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Tenant not found' })
    async toggle(@Param('id') id: string) {
        return this.adminTenantsService.toggle(id);
    }
}
