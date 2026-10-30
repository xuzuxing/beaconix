import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiForbiddenResponse,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SuperAdminGuard } from '../../../common/guards';
import { QueryAlertDeliveriesDto } from './query-alert-deliveries.dto';
import { AdminAlertDeliveriesService } from './admin-alert-deliveries.service';

@ApiTags('Admin / Alert deliveries')
@ApiBearerAuth('access-token')
@UseGuards(SuperAdminGuard)
@Controller('admin/alert-deliveries')
export class AdminAlertDeliveriesController {
    constructor(private readonly deliveries: AdminAlertDeliveriesService) {}

    @Get()
    @ApiOperation({
        summary: 'List channel deliveries across tenants; defaults to FAILED',
    })
    @ApiOkResponse({
        description:
            'Paginated safe delivery metadata; retry using the existing project endpoint',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    findAll(@Query() query: QueryAlertDeliveriesDto) {
        return this.deliveries.findAll(query);
    }
}
