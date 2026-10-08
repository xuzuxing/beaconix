import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RegenerateRecoveryCodesDto {
    @ApiProperty({ example: 'StrongP@ss1' })
    @IsString()
    @IsNotEmpty()
    currentPassword: string;

    @ApiProperty({
        example: '123456',
        description: 'TOTP code, or a recovery code',
    })
    @IsString()
    @IsNotEmpty()
    code: string;
}
