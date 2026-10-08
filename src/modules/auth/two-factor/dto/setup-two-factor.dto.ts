import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class SetupTwoFactorDto {
    @ApiProperty({ example: 'StrongP@ss1' })
    @IsString()
    @IsNotEmpty()
    currentPassword: string;
}
