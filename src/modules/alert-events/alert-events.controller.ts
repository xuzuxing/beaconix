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
import { AuditLog } from '../../common/decorators';
import { ProjectAccessGuard } from '../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../common/authorization/project-permission.decorator';
import { CurrentPrincipal } from '../../common/authorization/current-principal.decorator';
import type { AccessPrincipal } from '../../common/authorization/access.types';
import { AlertEventsService } from './alert-events.service';

@ApiTags('Monitoring')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/monitoring/alert-deliveries')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('alert.retry', {
    resourceType: 'PROJECT',
    idParam: 'projectId',
})
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
    @ApiForbiddenResponse({ description: 'Project administrator required' })
    @ApiNotFoundResponse({ description: 'Project not found' })
    retry(
        @Param('projectId') projectId: string,
        @Param('deliveryId') deliveryId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.events.retry(projectId, deliveryId, principal);
    }
}
