import { Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiConflictResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import { AuditLog, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards';
import { AlertEventsService } from './alert-events.service';

@ApiTags('Monitoring')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/monitoring/alert-deliveries')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class AlertEventsController {
    constructor(private readonly events: AlertEventsService) {}

    @Post(':deliveryId/retry')
    @HttpCode(200)
    @AuditLog({ entity: 'AlertDelivery' })
    @ApiOperation({
        summary: 'Retry a terminally failed alert delivery (admin)',
    })
    @ApiOkResponse({
        description:
            'Delivery pending again; existing attempt logs are preserved',
    })
    @ApiConflictResponse({
        description: 'Delivery is not failed or not in this project',
    })
    @ApiForbiddenResponse({ description: 'Organization admin required' })
    @ApiNotFoundResponse({ description: 'Project not found' })
    retry(
        @Param('projectId') projectId: string,
        @Param('deliveryId') deliveryId: string,
    ) {
        return this.events.retry(projectId, deliveryId);
    }
}
