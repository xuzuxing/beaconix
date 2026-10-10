import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class DeviceTokenDto {
    @ApiProperty({
        description: 'deviceCode returned by POST /probes/enroll/device',
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(128)
    deviceCode: string;
}
