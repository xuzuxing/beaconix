import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    UseGuards,
} from '@nestjs/common';
import {
    ApiAcceptedResponse,
    ApiBearerAuth,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
} from '@nestjs/swagger';
import type { AccessPrincipal } from '../../../common/authorization/access.types';
import { CurrentPrincipal } from '../../../common/authorization/current-principal.decorator';
import { ProjectAccessGuard } from '../../../common/authorization/project-access.guard';
import { ProjectPermission } from '../../../common/authorization/project-permission.decorator';
import { AuditLog } from '../../../common/decorators';
import { CreateRumSubjectDeletionDto } from '../dto';
import { RumMaintenanceJobEntity } from './rum-maintenance.entity';
import { RumMaintenanceService } from './rum-maintenance.service';

@ApiTags('RUM Maintenance')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/apps/:appId')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('app.manage', {
    resourceType: 'RUM_APP',
    idParam: 'appId',
})
export class RumMaintenanceController {
    constructor(private readonly maintenance: RumMaintenanceService) {}

    @Post('purge')
    @HttpCode(HttpStatus.ACCEPTED)
    @AuditLog({ entity: 'RumApp', idParam: 'appId', action: 'UPDATE' })
    @ApiOperation({
        summary:
            'Queue a purge of all RUM data for an app (app and configuration are kept)',
    })
    @ApiAcceptedResponse({ type: RumMaintenanceJobEntity })
    @ApiNotFoundResponse({ description: 'RUM app not found' })
    purge(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.maintenance.requestPurge(projectId, appId, principal);
    }

    @Post('subjects/deletion')
    @HttpCode(HttpStatus.ACCEPTED)
    @AuditLog({ entity: 'RumApp', idParam: 'appId', action: 'UPDATE' })
    @ApiOperation({
        summary:
            'Queue deletion of everything reported by one end user (occurrences, events, perf samples and related replays)',
    })
    @ApiAcceptedResponse({ type: RumMaintenanceJobEntity })
    @ApiNotFoundResponse({ description: 'RUM app not found' })
    deleteSubject(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Body() dto: CreateRumSubjectDeletionDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.maintenance.requestSubjectDeletion(
            projectId,
            appId,
            dto,
            principal,
        );
    }

    @Get('maintenance-jobs/:jobId')
    @ProjectPermission('rum.read', {
        resourceType: 'RUM_APP',
        idParam: 'appId',
    })
    @ApiOperation({ summary: 'Inspect a purge or subject-deletion job' })
    @ApiParam({ name: 'jobId', description: 'RUM maintenance job CUID' })
    @ApiOkResponse({ type: RumMaintenanceJobEntity })
    @ApiNotFoundResponse({ description: 'RUM maintenance job not found' })
    findJob(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Param('jobId') jobId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.maintenance.findJob(projectId, appId, jobId, principal);
    }
}
