import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Client description the probe CLI sends when it starts a device flow. */
export class DeviceAuthorizationDto {
    @ApiPropertyOptional({ example: 'beaconix-probe-cli' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    client?: string;

    @ApiPropertyOptional({ example: 'host-01' })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    hostname?: string;

    @ApiPropertyOptional({ example: 'linux/x64' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    platform?: string;

    @ApiPropertyOptional({ example: 'v22.0.0' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    runtime?: string;
}
