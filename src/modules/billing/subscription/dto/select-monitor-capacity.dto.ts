import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray } from 'class-validator';
import { IsCuid } from '../../../../common/decorators/is-cuid.decorator';

export class SelectMonitorCapacityDto {
    @ApiProperty({
        description: 'Current downgrade cycle; prevents stale selections',
    })
    @IsCuid()
    cycleId: string;

    @ApiProperty({
        type: [String],
        description:
            'Preferred retained monitors, in priority order; remaining slots are filled by creation time and ID',
    })
    @IsArray()
    @ArrayUnique()
    @ArrayMaxSize(10000)
    @IsCuid({ each: true })
    monitorIds: string[];
}
