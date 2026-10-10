import { Module } from '@nestjs/common';
import { ProbesModule } from './probes.module';
import { ProbeEnrollmentController } from './probe-enrollment.controller';
import { ProbeEnrollmentService } from './probe-enrollment.service';

@Module({
    imports: [ProbesModule],
    controllers: [ProbeEnrollmentController],
    providers: [ProbeEnrollmentService],
    exports: [ProbeEnrollmentService],
})
export class ProbeEnrollmentModule {}
