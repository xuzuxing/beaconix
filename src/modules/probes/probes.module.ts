import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { CheckerModule } from '../checker/checker.module';
import { ProbeIngestController } from './probe-ingest.controller';
import { ProbesController } from './probes.controller';
import { ProbesService } from './probes.service';

@Module({
    imports: [CheckerModule, AdminModule],
    controllers: [ProbesController, ProbeIngestController],
    providers: [ProbesService],
    exports: [ProbesService],
})
export class ProbesModule {}
