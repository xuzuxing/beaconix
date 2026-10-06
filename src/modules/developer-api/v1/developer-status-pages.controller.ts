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
import { SkipThrottle } from '@nestjs/throttler';
import { AuditLog, Public } from '../../../common/decorators';
import {
    CreateStatusPageDto,
    UpdateStatusPageDto,
} from '../../status-pages/dto';
import { StatusPageEntity } from '../../status-pages/entities';
import { StatusPagesService } from '../../status-pages/status-pages.service';
import { DeveloperAuthGuard } from '../auth/developer-auth.guard';
import { RequireScopes } from '../auth/require-scopes.decorator';

@ApiTags('Developer API - Status pages')
@ApiBearerAuth('developer-api-key')
@Controller('developer/v1')
@SkipThrottle({ default: true })
export class DeveloperStatusPagesController {
    constructor(private readonly statusPagesService: StatusPagesService) {}

    @Get('organizations/:orgId/status-pages')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('status-pages:read')
    @ApiOperation({ summary: 'List status pages in the organization' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiOkResponse({ type: [StatusPageEntity] })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    async findAll(@Param('orgId') orgId: string) {
        return this.statusPagesService.findAll(orgId);
    }

    @Post('organizations/:orgId/status-pages')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('status-pages:write')
    @AuditLog({ entity: 'StatusPage' })
    @ApiOperation({ summary: 'Create a status page' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiBody({ type: CreateStatusPageDto })
    @ApiCreatedResponse({ type: StatusPageEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    async create(
        @Param('orgId') orgId: string,
        @Body() dto: CreateStatusPageDto,
    ) {
        return this.statusPagesService.create(orgId, dto);
    }

    @Get('organizations/:orgId/status-pages/:id')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('status-pages:read')
    @ApiOperation({ summary: 'Get a status page' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Status page UUID' })
    @ApiOkResponse({ type: StatusPageEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    @ApiNotFoundResponse({ description: 'Status page not found' })
    async findOne(@Param('orgId') orgId: string, @Param('id') id: string) {
        return this.statusPagesService.findOne(orgId, id);
    }

    @Patch('organizations/:orgId/status-pages/:id')
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('status-pages:write')
    @AuditLog({ entity: 'StatusPage' })
    @ApiOperation({ summary: 'Update a status page' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Status page UUID' })
    @ApiBody({ type: UpdateStatusPageDto })
    @ApiOkResponse({ type: StatusPageEntity })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    @ApiNotFoundResponse({ description: 'Status page not found' })
    async update(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @Body() dto: UpdateStatusPageDto,
    ) {
        return this.statusPagesService.update(orgId, id, dto);
    }

    @Delete('organizations/:orgId/status-pages/:id')
    @HttpCode(HttpStatus.OK)
    @Public()
    @UseGuards(DeveloperAuthGuard)
    @RequireScopes('status-pages:write')
    @AuditLog({ entity: 'StatusPage', action: 'DELETE' })
    @ApiOperation({ summary: 'Delete a status page' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Status page UUID' })
    @ApiOkResponse({ description: 'Status page deleted' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid API key' })
    @ApiForbiddenResponse({ description: 'Missing scope' })
    @ApiNotFoundResponse({ description: 'Status page not found' })
    async remove(@Param('orgId') orgId: string, @Param('id') id: string) {
        return this.statusPagesService.remove(orgId, id);
    }
}
