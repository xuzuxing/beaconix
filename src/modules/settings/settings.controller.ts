import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
import { SuperAdminGuard } from '../../common/guards';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { UpdateSettingDto } from './dto';
import { SettingEntity } from './entities';
import { SettingsService } from './settings.service';

@ApiTags('Admin / Settings')
@ApiBearerAuth('access-token')
@UseGuards(SuperAdminGuard)
@Controller('admin/settings')
export class SettingsController {
    constructor(private readonly settingsService: SettingsService) {}

    @Get()
    @ApiOperation({ summary: 'List platform runtime settings' })
    @ApiOkResponse({
        type: [SettingEntity],
        description: 'Configured settings plus built-in defaults',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    async findAll() {
        return this.settingsService.findAll();
    }

    @Get(':key')
    @ApiOperation({ summary: 'Get one platform runtime setting' })
    @ApiParam({ name: 'key', example: 'storage.driver' })
    @ApiOkResponse({ type: SettingEntity, description: 'Setting detail' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    @ApiNotFoundResponse({ description: 'Setting not found' })
    async findOne(@Param('key') key: string) {
        return this.settingsService.findOne(key);
    }

    @Patch(':key')
    @ApiOperation({ summary: 'Update one platform runtime setting' })
    @ApiParam({ name: 'key', example: 'storage.driver' })
    @ApiBody({ type: UpdateSettingDto })
    @ApiOkResponse({ type: SettingEntity, description: 'Updated setting' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
    async update(
        @Param('key') key: string,
        @Body() dto: UpdateSettingDto,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.settingsService.update(key, dto, user.sub);
    }
}
