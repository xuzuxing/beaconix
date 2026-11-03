import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class UploadRumSourceMapDto {
    @ApiProperty({ example: 'web-2026.11.03.1' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    release: string;

    @ApiProperty({ example: '/assets/index-a1b2c3.js' })
    @IsString()
    @MinLength(1)
    @MaxLength(2048)
    @Matches(/\.m?js(?:[?#].*)?$/i, {
        message: 'artifactPath must identify a JavaScript artifact',
    })
    artifactPath: string;
}
