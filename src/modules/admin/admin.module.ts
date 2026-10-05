import { Module } from '@nestjs/common';
import { SystemProbesController } from './system-probes/system-probes.controller';
import { SystemProbeAssignmentStore } from './system-probes/system-probe-assignment.store';
import { SystemProbeScheduler } from './system-probes/system-probe-scheduler';
import { SystemProbesService } from './system-probes/system-probes.service';

@Module({
    controllers: [SystemProbesController],
    providers: [
        SystemProbesService,
        SystemProbeScheduler,
        SystemProbeAssignmentStore,
    ],
    exports: [SystemProbeScheduler],
})
export class AdminModule {}
