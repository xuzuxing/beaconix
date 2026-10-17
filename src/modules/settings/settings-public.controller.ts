import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators';
import { SettingsService } from './settings.service';

/**
 * 公开的展示型配置（站点名称、Logo、页脚版权、默认语言、维护模式等）。
 *
 * 登录页、状态页这些未登录场景也要读，所以这里跳过 JWT；
 * 具体哪些 key 能出现在响应里由 `SETTING_DEFINITIONS` 的 `isPublic` 决定，
 * 不在这份控制器里维护第二份白名单。
 */
@ApiTags('Settings')
@Controller('settings')
export class SettingsPublicController {
    constructor(private readonly settingsService: SettingsService) {}

    @Get('public')
    @Public()
    @ApiOperation({ summary: 'Read the publicly exposed platform settings' })
    @ApiOkResponse({
        description:
            'Flat map of public setting keys to their current values. Secret settings and internal runtime parameters are never included.',
        schema: { type: 'object', additionalProperties: true },
    })
    async findPublic() {
        return this.settingsService.findPublic();
    }
}
