import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class VerifyTwoFactorLoginDto {
    @ApiProperty({ example: 'clx123abc.raw-token' })
    @IsString()
    @IsNotEmpty()
    challengeId: string;

    @ApiProperty({
        example: '123456',
        description: 'TOTP code, or a recovery code when the device is lost',
    })
    @IsString()
    @IsNotEmpty()
    code: string;
}
