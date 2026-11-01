import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service';

/** Shared settings access without exposing the management/public controllers. */
@Module({
    providers: [SettingsService],
    exports: [SettingsService],
})
export class SettingsCoreModule {}
