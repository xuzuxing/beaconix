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
    ApiBody,
    ApiConflictResponse,
    ApiCreatedResponse,
    ApiForbiddenResponse,
    ApiNoContentResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuditLog, CurrentUser } from '../../../common/decorators';
import { SuperAdminGuard } from '../../../common/guards';
import type { JwtPayload } from '../../../common/interfaces/jwt-payload.interface';
import { AdminTicketsService } from './admin-tickets.service';
import {
    AdminTicketReplyDto,
    QueryAdminTicketsDto,
    UpdateTicketDto,
} from './dto';
import { TicketEntity } from '../../tickets/entities';

@ApiTags('Admin / Tickets')
@ApiBearerAuth('access-token')
@UseGuards(SuperAdminGuard)
@Controller('admin/tickets')
export class AdminTicketsController {
    constructor(private readonly adminTicketsService: AdminTicketsService) {}

    @Get()
    @ApiOperation({ summary: 'List every ticket across the platform' })
    @ApiOkResponse({ description: 'Paginated ticket list' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    async findAll(@Query() query: QueryAdminTicketsDto) {
        return this.adminTicketsService.findAll(query);
    }

    @Get('stats')
    @ApiOperation({ summary: 'Ticket counters grouped by status and priority' })
    @ApiOkResponse({ description: 'Ticket statistics' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    async findStats() {
        return this.adminTicketsService.findStats();
    }

    @Get(':ticketId')
    @ApiOperation({ summary: 'Get one ticket with its full timeline' })
    @ApiParam({ name: 'ticketId', description: 'Ticket CUID' })
    @ApiOkResponse({ description: 'Ticket detail including internal notes' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Ticket not found' })
    async findOne(@Param('ticketId') ticketId: string) {
        return this.adminTicketsService.findOne(ticketId);
    }

    @Patch(':ticketId')
    @AuditLog({ entity: 'Ticket', idParam: 'ticketId' })
    @ApiOperation({
        summary: 'Update status, priority, category or assignee',
    })
    @ApiParam({ name: 'ticketId', description: 'Ticket CUID' })
    @ApiBody({ type: UpdateTicketDto })
    @ApiOkResponse({ type: TicketEntity, description: 'Ticket updated' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Ticket not found' })
    @ApiConflictResponse({ description: 'Invalid status transition' })
    async update(
        @Param('ticketId') ticketId: string,
        @CurrentUser() user: JwtPayload,
        @Body() dto: UpdateTicketDto,
    ) {
        return this.adminTicketsService.update(ticketId, user.sub, dto);
    }

    @Post(':ticketId/replies')
    @AuditLog({ entity: 'Ticket', idParam: 'ticketId' })
    @ApiOperation({ summary: 'Reply on a ticket (public reply or note)' })
    @ApiParam({ name: 'ticketId', description: 'Ticket CUID' })
    @ApiBody({ type: AdminTicketReplyDto })
    @ApiCreatedResponse({ description: 'Reply created' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Ticket not found' })
    async reply(
        @Param('ticketId') ticketId: string,
        @CurrentUser() user: JwtPayload,
        @Body() dto: AdminTicketReplyDto,
    ) {
        return this.adminTicketsService.reply(ticketId, user.sub, dto);
    }

    @Delete(':ticketId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @AuditLog({ entity: 'Ticket', idParam: 'ticketId' })
    @ApiOperation({ summary: 'Soft-delete a spam or test ticket' })
    @ApiParam({ name: 'ticketId', description: 'Ticket CUID' })
    @ApiNoContentResponse({ description: 'Ticket soft-deleted' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Ticket not found' })
    async remove(@Param('ticketId') ticketId: string) {
        await this.adminTicketsService.remove(ticketId);
    }
}
