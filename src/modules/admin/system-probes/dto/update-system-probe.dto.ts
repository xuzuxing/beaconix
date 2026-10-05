import { PartialType } from '@nestjs/swagger';
import { CreateSystemProbeDto } from './create-system-probe.dto';

export class UpdateSystemProbeDto extends PartialType(CreateSystemProbeDto) {}
