import { Controller, Get } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { TicketCategoriesService } from './ticket-categories.service';
import { TicketCategoryEntity } from './entities';
import { SkipMaintenance } from '../../common/decorators';

/**
 * Registered before {@link TicketsController} in the module so that
 * `GET /api/tickets/categories` is matched before `GET /api/tickets/:ticketId`.
 */
@ApiTags('Tickets')
@ApiBearerAuth('access-token')
@SkipMaintenance()
@Controller('tickets')
export class TicketCategoriesController {
    constructor(
        private readonly ticketCategoriesService: TicketCategoriesService,
    ) {}

    @Get('categories')
    @ApiOperation({ summary: 'List the categories available when submitting' })
    @ApiOkResponse({
        type: [TicketCategoryEntity],
        description: 'Active categories ordered for display',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    async findAll() {
        return this.ticketCategoriesService.listActive();
    }
}
