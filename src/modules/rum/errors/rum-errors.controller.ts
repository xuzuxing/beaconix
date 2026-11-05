import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiCreatedResponse,
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
import {
    CreateRumErrorNoteDto,
    QueryRumErrorNotesDto,
    QueryRumErrorOccurrencesDto,
    QueryRumErrorOverviewDto,
    QueryRumErrorsDto,
    UpdateRumErrorDto,
} from '../dto';
import {
    RumErrorGroupEntity,
    RumErrorGroupListEntity,
    RumErrorNoteEntity,
    RumErrorNoteListEntity,
    RumErrorOccurrenceListEntity,
} from '../entities';
import { RumErrorsService } from './rum-errors.service';
import { RumErrorOverviewEntity } from './rum-error-overview.entity';
import { RumErrorOverviewService } from './rum-error-overview.service';

@ApiTags('RUM Errors')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/apps/:appId/errors')
@UseGuards(ProjectAccessGuard)
@ProjectPermission('rum.read', {
    resourceType: 'RUM_APP',
    idParam: 'appId',
})
export class RumErrorsController {
    constructor(
        private readonly errors: RumErrorsService,
        private readonly overview: RumErrorOverviewService,
    ) {}

    @Get()
    @ApiOperation({ summary: 'List aggregated errors for a RUM app' })
    @ApiOkResponse({ type: RumErrorGroupListEntity })
    findAll(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Query() query: QueryRumErrorsDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.errors.findAll(projectId, appId, query, principal);
    }

    // 必须声明在 :errorId 之前，否则 /errors/overview 会被当成错误组 ID
    @Get('overview')
    @ApiOperation({
        summary:
            'Error overview: occurrence totals, error rate against page views and the matching time series',
    })
    @ApiOkResponse({ type: RumErrorOverviewEntity })
    @ApiNotFoundResponse({ description: 'RUM app not found' })
    overviewOfErrors(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Query() query: QueryRumErrorOverviewDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.overview.overview(projectId, appId, query, principal);
    }

    @Get(':errorId')
    @ApiOperation({ summary: 'Get an aggregated RUM error' })
    @ApiParam({ name: 'errorId', description: 'RUM error group CUID' })
    @ApiOkResponse({ type: RumErrorGroupEntity })
    @ApiNotFoundResponse({ description: 'RUM error not found' })
    findOne(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Param('errorId') errorId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.errors.findOne(projectId, appId, errorId, principal);
    }

    @Patch(':errorId')
    @ProjectPermission('rum.read', {
        resourceType: 'RUM_APP',
        idParam: 'appId',
    })
    @AuditLog({ entity: 'RumErrorGroup', idParam: 'errorId' })
    @ApiOperation({
        summary:
            'Update error lifecycle status, ignore window or assignee (assigning another member needs app.manage)',
    })
    @ApiParam({ name: 'errorId', description: 'RUM error group CUID' })
    @ApiOkResponse({ type: RumErrorGroupEntity })
    @ApiNotFoundResponse({ description: 'RUM error not found' })
    update(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Param('errorId') errorId: string,
        @Body() dto: UpdateRumErrorDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.errors.update(projectId, appId, errorId, dto, principal);
    }

    @Get(':errorId/occurrences')
    @ApiOperation({ summary: 'List occurrences for an aggregated RUM error' })
    @ApiParam({ name: 'errorId', description: 'RUM error group CUID' })
    @ApiOkResponse({ type: RumErrorOccurrenceListEntity })
    @ApiNotFoundResponse({ description: 'RUM error not found' })
    findOccurrences(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Param('errorId') errorId: string,
        @Query() query: QueryRumErrorOccurrencesDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.errors.findOccurrences(
            projectId,
            appId,
            errorId,
            query,
            principal,
        );
    }

    @Get(':errorId/notes')
    @ProjectPermission('rum.read', {
        resourceType: 'RUM_APP',
        idParam: 'appId',
    })
    @ApiOperation({ summary: 'List handling notes for a RUM error group' })
    @ApiParam({ name: 'errorId', description: 'RUM error group CUID' })
    @ApiOkResponse({ type: RumErrorNoteListEntity })
    @ApiNotFoundResponse({ description: 'RUM error not found' })
    listNotes(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Param('errorId') errorId: string,
        @Query() query: QueryRumErrorNotesDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.errors.notes(projectId, appId, errorId, query, principal);
    }

    @Post(':errorId/notes')
    @ProjectPermission('rum.read', {
        resourceType: 'RUM_APP',
        idParam: 'appId',
    })
    @AuditLog({ entity: 'RumErrorNote' })
    @ApiOperation({ summary: 'Add a handling note to a RUM error group' })
    @ApiParam({ name: 'errorId', description: 'RUM error group CUID' })
    @ApiCreatedResponse({ type: RumErrorNoteEntity })
    addNote(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Param('errorId') errorId: string,
        @Body() dto: CreateRumErrorNoteDto,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.errors.createNote(
            projectId,
            appId,
            errorId,
            dto,
            principal,
        );
    }

    @Delete(':errorId/notes/:noteId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ProjectPermission('rum.read', {
        resourceType: 'RUM_APP',
        idParam: 'appId',
    })
    @AuditLog({ entity: 'RumErrorNote', idParam: 'noteId' })
    @ApiOperation({
        summary: 'Delete a handling note (author or app.manage only)',
    })
    @ApiParam({ name: 'errorId', description: 'RUM error group CUID' })
    @ApiParam({ name: 'noteId', description: 'RUM error note CUID' })
    @ApiNotFoundResponse({ description: 'RUM error note not found' })
    removeNote(
        @Param('projectId') projectId: string,
        @Param('appId') appId: string,
        @Param('errorId') errorId: string,
        @Param('noteId') noteId: string,
        @CurrentPrincipal() principal: AccessPrincipal,
    ) {
        return this.errors.removeNote(
            projectId,
            appId,
            errorId,
            noteId,
            principal,
        );
    }
}
