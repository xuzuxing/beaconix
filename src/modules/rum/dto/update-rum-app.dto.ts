import { PartialType } from '@nestjs/swagger';
import { CreateRumAppDto } from './create-rum-app.dto';

export class UpdateRumAppDto extends PartialType(CreateRumAppDto) {}
