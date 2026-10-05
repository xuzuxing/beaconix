import { Module } from '@nestjs/common';
import { ProbeValidationService } from './probe-validation.service';

@Module({
    providers: [ProbeValidationService],
    exports: [ProbeValidationService],
})
export class ProbeValidationModule {}
