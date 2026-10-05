import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class ToggleSystemProbeDto {
    @ApiProperty({ example: false })
    @IsBoolean()
    enabled: boolean;
}
