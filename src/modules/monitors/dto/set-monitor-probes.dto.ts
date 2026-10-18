import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';

export class SetMonitorProbesDto {
    @ApiProperty({
        example: ['clx123probe1', 'clx123probe2'],
        description:
            'Exact set of tenant probes to assign to this monitor; an empty array detaches every probe. The plan per-monitor probe limit applies',
        type: [String],
    })
    @IsArray()
    @ArrayMaxSize(200)
    @IsString({ each: true })
    probeIds: string[];
}
