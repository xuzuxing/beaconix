import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
} from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiBody,
    ApiConflictResponse,
    ApiCreatedResponse,
    ApiExtraModels,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
    getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { TicketsService } from './tickets.service';
import { CreateTicketDto, CreateTicketReplyDto, QueryTicketsDto } from './dto';
import { TicketEntity } from './entities';

/**
 * User-facing ticket surface: every ticket here belongs to the caller.
 * Authorization is the global `JwtAuthGuard` plus `authorId = jwt.sub` in the
 * service layer — no tenant guards, because tickets are platform resources.
 */
@ApiTags('Tickets')
@ApiBearerAuth('access-token')
@ApiExtraModels(TicketEntity)
@Controller('tickets')
export class TicketsController {
    constructor(private readonly ticketsService: TicketsService) {}

    @Post()
    @ApiOperation({ summary: 'Submit a support ticket' })
    @ApiBody({ type: CreateTicketDto })
    @ApiCreatedResponse({ type: TicketEntity, description: 'Ticket created' })
    @ApiBadRequestResponse({
        description: 'Validation error or unusable category',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    async create(
        @CurrentUser() user: JwtPayload,
        @Body() dto: CreateTicketDto,
    ) {
        return this.ticketsService.create(user.sub, dto);
    }

    @Get()
    @ApiOperation({ summary: 'List my tickets with filters and pagination' })
    @ApiOkResponse({
        description: 'Paginated ticket list',
        schema: {
            properties: {
                items: {
                    type: 'array',
                    items: { $ref: getSchemaPath(TicketEntity) },
                },
                total: { type: 'number', example: 12 },
                page: { type: 'number', example: 1 },
                limit: { type: 'number', example: 20 },
                totalPages: { type: 'number', example: 1 },
            },
        },
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    async findMine(
        @CurrentUser() user: JwtPayload,
        @Query() query: QueryTicketsDto,
    ) {
        return this.ticketsService.findMine(user.sub, query);
    }

    @Get(':ticketId')
    @ApiOperation({
        summary: 'Get one of my tickets with its merged timeline',
    })
    @ApiParam({ name: 'ticketId', description: 'Ticket CUID' })
    @ApiOkResponse({ description: 'Ticket detail with timeline' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiNotFoundResponse({ description: 'Ticket not found' })
    async findOne(
        @CurrentUser() user: JwtPayload,
        @Param('ticketId') ticketId: string,
    ) {
        return this.ticketsService.findOne(user.sub, ticketId);
    }

    @Post(':ticketId/replies')
    @ApiOperation({
        summary: 'Reply on my ticket (reopens a resolved/closed ticket)',
    })
    @ApiParam({ name: 'ticketId', description: 'Ticket CUID' })
    @ApiBody({ type: CreateTicketReplyDto })
    @ApiCreatedResponse({ description: 'Reply created' })
    @ApiBadRequestResponse({ description: 'Validation error' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiNotFoundResponse({ description: 'Ticket not found' })
    async reply(
        @CurrentUser() user: JwtPayload,
        @Param('ticketId') ticketId: string,
        @Body() dto: CreateTicketReplyDto,
    ) {
        return this.ticketsService.reply(user.sub, ticketId, dto);
    }

    @Post(':ticketId/close')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Confirm resolution and close my ticket' })
    @ApiParam({ name: 'ticketId', description: 'Ticket CUID' })
    @ApiOkResponse({ type: TicketEntity, description: 'Ticket closed' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiNotFoundResponse({ description: 'Ticket not found' })
    @ApiConflictResponse({ description: 'Ticket is already closed' })
    async close(
        @CurrentUser() user: JwtPayload,
        @Param('ticketId') ticketId: string,
    ) {
        return this.ticketsService.close(user.sub, ticketId);
    }
}
