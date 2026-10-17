import {
    Body,
    Controller,
    Delete,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
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
import { AuditLog } from '../../../common/decorators';
import { SuperAdminGuard } from '../../../common/guards';
import { AdminTicketCategoriesService } from './admin-ticket-categories.service';
import { CreateTicketCategoryDto, UpdateTicketCategoryDto } from './dto';
import { TicketCategoryEntity } from '../../tickets/entities';

@ApiTags('Admin / Tickets')
@ApiBearerAuth('access-token')
@UseGuards(SuperAdminGuard)
@Controller('admin/ticket-categories')
export class AdminTicketCategoriesController {
    constructor(private readonly categories: AdminTicketCategoriesService) {}

    @Post()
    @AuditLog({ entity: 'TicketCategory' })
    @ApiOperation({ summary: 'Create a ticket category' })
    @ApiBody({ type: CreateTicketCategoryDto })
    @ApiCreatedResponse({
        type: TicketCategoryEntity,
        description: 'Category created',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiConflictResponse({ description: 'Category name already exists' })
    async create(@Body() dto: CreateTicketCategoryDto) {
        return this.categories.create(dto);
    }

    @Patch(':categoryId')
    @AuditLog({ entity: 'TicketCategory', idParam: 'categoryId' })
    @ApiOperation({ summary: 'Update or deactivate a ticket category' })
    @ApiParam({ name: 'categoryId', description: 'Category CUID' })
    @ApiBody({ type: UpdateTicketCategoryDto })
    @ApiOkResponse({
        type: TicketCategoryEntity,
        description: 'Category updated',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Category not found' })
    @ApiConflictResponse({ description: 'Category name already exists' })
    async update(
        @Param('categoryId') categoryId: string,
        @Body() dto: UpdateTicketCategoryDto,
    ) {
        return this.categories.update(categoryId, dto);
    }

    @Delete(':categoryId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @AuditLog({ entity: 'TicketCategory', idParam: 'categoryId' })
    @ApiOperation({ summary: 'Delete an unused ticket category' })
    @ApiParam({ name: 'categoryId', description: 'Category CUID' })
    @ApiNoContentResponse({ description: 'Category deleted' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Category not found' })
    @ApiConflictResponse({
        description: 'Category is referenced by tickets',
    })
    async remove(@Param('categoryId') categoryId: string) {
        await this.categories.remove(categoryId);
    }
}
