import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Body,
    Param,
    Query,
    HttpCode,
    HttpStatus,
    UseGuards,
} from '@nestjs/common';
import {
    ApiTags,
    ApiBearerAuth,
    ApiOperation,
    ApiParam,
    ApiBody,
    ApiQuery,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiBadRequestResponse,
    ApiUnauthorizedResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
} from '@nestjs/swagger';
import { NotificationChannelsService } from './notification-channels.service';
import { NotifierService } from './notifier.service';
import {
    CreateNotificationChannelDto,
    QueryNotificationLogsDto,
    UpdateNotificationChannelDto,
} from './dto';
import { NotificationChannelEntity } from './entities';
import { Roles, AuditLog } from '../../common/decorators';
import { RolesGuard, OrgMemberGuard } from '../../common/guards';

@ApiTags('Notification Channels')
@ApiBearerAuth('access-token')
@Controller('organizations/:orgId/notification-channels')
export class NotificationChannelsController {
    constructor(
        private readonly channelsService: NotificationChannelsService,
        private readonly notifierService: NotifierService,
    ) {}

    @Get()
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'List notification channels of the organization' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiOkResponse({
        type: [NotificationChannelEntity],
        description: 'List of notification channels',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    async findAll(@Param('orgId') orgId: string) {
        return this.channelsService.findAll(orgId);
    }

    @Post()
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'NotificationChannel' })
    @ApiOperation({ summary: 'Create a notification channel' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiBody({ type: CreateNotificationChannelDto })
    @ApiCreatedResponse({
        type: NotificationChannelEntity,
        description: 'Channel created',
    })
    @ApiBadRequestResponse({
        description: 'Validation failed, or the config does not fit the type',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    async create(
        @Param('orgId') orgId: string,
        @Body() dto: CreateNotificationChannelDto,
    ) {
        return this.channelsService.create(orgId, dto);
    }

    @Get(':id')
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'Get a notification channel by ID' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Channel UUID' })
    @ApiOkResponse({
        type: NotificationChannelEntity,
        description: 'Channel details',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    @ApiNotFoundResponse({ description: 'Channel not found' })
    async findOne(@Param('orgId') orgId: string, @Param('id') id: string) {
        return this.channelsService.findOne(orgId, id);
    }

    @Patch(':id')
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'NotificationChannel' })
    @ApiOperation({ summary: 'Update a notification channel' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Channel UUID' })
    @ApiBody({ type: UpdateNotificationChannelDto })
    @ApiOkResponse({
        type: NotificationChannelEntity,
        description: 'Channel updated',
    })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Channel not found' })
    async update(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @Body() dto: UpdateNotificationChannelDto,
    ) {
        return this.channelsService.update(orgId, id, dto);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'NotificationChannel', action: 'DELETE' })
    @ApiOperation({ summary: 'Delete a notification channel' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Channel UUID' })
    @ApiOkResponse({ description: 'Channel deleted' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Channel not found' })
    async remove(@Param('orgId') orgId: string, @Param('id') id: string) {
        await this.channelsService.remove(orgId, id);
        return { id, deleted: true };
    }

    @Post(':id/test')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @ApiOperation({ summary: 'Send a test message through the channel' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Channel UUID' })
    @ApiOkResponse({
        description: '{ delivered: boolean, error: string | null }',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Channel not found' })
    async test(@Param('orgId') orgId: string, @Param('id') id: string) {
        return this.notifierService.sendTestMessage(orgId, id);
    }

    @Get(':id/logs')
    @UseGuards(OrgMemberGuard)
    @ApiOperation({ summary: 'List delivery attempts of a channel' })
    @ApiParam({ name: 'orgId', description: 'Organization UUID' })
    @ApiParam({ name: 'id', description: 'Channel UUID' })
    @ApiQuery({ type: QueryNotificationLogsDto })
    @ApiOkResponse({ description: 'Paginated notification logs' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    @ApiNotFoundResponse({ description: 'Channel not found' })
    async logs(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @Query() query: QueryNotificationLogsDto,
    ) {
        return this.channelsService.findLogs(orgId, id, query);
    }
}
