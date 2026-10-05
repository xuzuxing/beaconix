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
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiCreatedResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuditLog, Roles } from '../../common/decorators';
import { OrgMemberGuard, RolesGuard } from '../../common/guards';
import { CreateStatusPageDto, UpdateStatusPageDto } from './dto';
import { StatusPageEntity } from './entities';
import { StatusPagesService } from './status-pages.service';

@ApiTags('Status Pages')
@ApiBearerAuth('access-token')
@Controller('organizations/:orgId/status-pages')
export class StatusPagesController {
    constructor(private readonly statusPagesService: StatusPagesService) {}

    @Get()
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'List the status pages of the organization' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiOkResponse({ type: [StatusPageEntity], description: 'Status pages' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    async findAll(@Param('orgId') orgId: string) {
        return this.statusPagesService.findAll(orgId);
    }

    @Post()
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'StatusPage' })
    @ApiOperation({ summary: 'Create a status page' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiBody({ type: CreateStatusPageDto })
    @ApiCreatedResponse({ type: StatusPageEntity, description: 'Created' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    async create(
        @Param('orgId') orgId: string,
        @Body() dto: CreateStatusPageDto,
    ) {
        return this.statusPagesService.create(orgId, dto);
    }

    @Get(':id')
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'Get a status page by ID' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Status page UUID' })
    @ApiOkResponse({ type: StatusPageEntity, description: 'Status page' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    @ApiNotFoundResponse({ description: 'Status page not found' })
    async findOne(@Param('orgId') orgId: string, @Param('id') id: string) {
        return this.statusPagesService.findOne(orgId, id);
    }

    @Patch(':id')
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'StatusPage' })
    @ApiOperation({ summary: 'Update a status page' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Status page UUID' })
    @ApiBody({ type: UpdateStatusPageDto })
    @ApiOkResponse({ type: StatusPageEntity, description: 'Updated' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Status page not found' })
    async update(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @Body() dto: UpdateStatusPageDto,
    ) {
        return this.statusPagesService.update(orgId, id, dto);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'StatusPage', action: 'DELETE' })
    @ApiOperation({ summary: 'Delete a status page' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Status page UUID' })
    @ApiOkResponse({ description: 'Deleted' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Status page not found' })
    async remove(@Param('orgId') orgId: string, @Param('id') id: string) {
        await this.statusPagesService.remove(orgId, id);
        return { id, deleted: true };
    }
}
