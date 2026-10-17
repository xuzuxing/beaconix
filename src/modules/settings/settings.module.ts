import { Global, Module } from '@nestjs/common';
import { SettingsPublicController } from './settings-public.controller';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Global()
@Module({
    controllers: [SettingsController, SettingsPublicController],
    providers: [SettingsService],
    exports: [SettingsService],
})
export class SettingsModule {}
