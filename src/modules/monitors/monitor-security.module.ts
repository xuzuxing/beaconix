import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MonitorSecretsService } from './monitor-secrets.service';

@Module({
    imports: [ConfigModule],
    providers: [MonitorSecretsService],
    exports: [MonitorSecretsService],
})
export class MonitorSecurityModule {}
