import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';

export class BindMonitorsDto {
    @ApiProperty({
        example: ['cmgu92m5x0005p8l4h8z6s3k6'],
        description: 'Monitors of the same organization to attach to the probe',
    })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(100)
    @IsString({ each: true })
    monitorIds: string[];
}
