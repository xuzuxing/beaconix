import { PartialType } from '@nestjs/swagger';
import { CreateStatusPageDto } from './create-status-page.dto';

export class UpdateStatusPageDto extends PartialType(CreateStatusPageDto) {}
