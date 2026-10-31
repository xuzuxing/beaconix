import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ProjectAccessGuard } from '../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../common/authorization/project-permission.decorator';
import { CurrentPrincipal } from '../../common/authorization/current-principal.decorator';
import type { AccessPrincipal } from '../../common/authorization/access.types';
import { AlertEventQueriesService } from './alert-event-queries.service';
import {
    AlertPageDto,
    QueryAlertEventsDto,
    QueryEventDeliveriesDto,
} from './dto/query-alert-events.dto';
import {
    AlertEventDetailEntity,
    AlertEventPageEntity,
    DeliveryAttemptPageEntity,
    EventDeliveryPageEntity,
} from './entities/alert-event.entity';

@ApiTags('Monitoring / Alert Events')
@ApiBearerAuth('access-token')
@ApiParam({ name: 'projectId', description: 'Project ID' })
@ApiUnauthorizedResponse({ description: 'Authentication required' })
@ApiForbiddenResponse({
    description: 'Project monitoring read permission required',
})
@ApiNotFoundResponse({
    description: 'Project, event or delivery not found in this scope',
})
@ApiBadRequestResponse({ description: 'Invalid query or time range' })
@Controller('projects/:projectId/monitoring/alert-events')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('monitoring.read', {
    resourceType: 'PROJECT',
    idParam: 'projectId',
})
export class AlertEventQueriesController {
    constructor(private readonly queries: AlertEventQueriesService) {}

    @Get()
    @ApiOperation({ summary: 'Filter and paginate project alert events' })
    @ApiOkResponse({ type: AlertEventPageEntity })
    findAll(
        @Param('projectId') projectId: string,
        @Query() query: QueryAlertEventsDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.queries.findAll(projectId, query, principal);
    }

    @Get(':eventId')
    @ApiParam({ name: 'eventId' })
    @ApiOperation({
        summary: 'Read an incident and its delivery status summary',
    })
    @ApiOkResponse({ type: AlertEventDetailEntity })
    findOne(
        @Param('projectId') projectId: string,
        @Param('eventId') eventId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.queries.findOne(projectId, eventId, principal);
    }

    @Get(':eventId/deliveries')
    @ApiParam({ name: 'eventId' })
    @ApiOperation({
        summary: 'Paginate an incident’s deliveries with safe channel metadata',
    })
    @ApiOkResponse({ type: EventDeliveryPageEntity })
    deliveries(
        @Param('projectId') projectId: string,
        @Param('eventId') eventId: string,
        @Query() query: QueryEventDeliveriesDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.queries.deliveries(projectId, eventId, query, principal);
    }

    @Get(':eventId/deliveries/:deliveryId/attempts')
    @ApiParam({ name: 'eventId' })
    @ApiParam({ name: 'deliveryId' })
    @ApiOperation({
        summary: 'Paginate recorded delivery attempts across manual retries',
    })
    @ApiOkResponse({ type: DeliveryAttemptPageEntity })
    attempts(
        @Param('projectId') projectId: string,
        @Param('eventId') eventId: string,
        @Param('deliveryId') deliveryId: string,
        @Query() query: AlertPageDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.queries.attempts(
            projectId,
            eventId,
            deliveryId,
            query,
            principal,
        );
    }
}
