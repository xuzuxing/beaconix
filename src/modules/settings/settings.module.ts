import { Global, Module } from '@nestjs/common';
import { SettingsPublicController } from './settings-public.controller';
import { SettingsController } from './settings.controller';
import { SettingsCoreModule } from './settings-core.module';

@Global()
@Module({
    imports: [SettingsCoreModule],
    controllers: [SettingsController, SettingsPublicController],
    exports: [SettingsCoreModule],
})
export class SettingsModule {}
