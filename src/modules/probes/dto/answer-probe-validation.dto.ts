import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, MaxLength, ValidateNested } from 'class-validator';

export class ProbeValidationCipherDto {
    @ApiProperty({
        example: 'MTIzNDU2Nzg5MDEy',
        description: 'AES-256-GCM initialization vector (base64)',
    })
    @IsString()
    @MaxLength(4096)
    iv: string;

    @ApiProperty({
        example: 'YWJjZGVmZ2hpamtsbW5vcA==',
        description: 'AES-256-GCM authentication tag (base64)',
    })
    @IsString()
    @MaxLength(4096)
    tag: string;

    @ApiProperty({
        example: 'aHR0cHM6Ly9iZWFjb24uZXhhbXBsZS5jb20=',
        description: 'AES-256-GCM ciphertext (base64)',
    })
    @IsString()
    @MaxLength(4096)
    data: string;
}

export class AnswerProbeValidationDto {
    @ApiProperty({
        type: ProbeValidationCipherDto,
        description: 'Encrypted answer produced by the probe',
    })
    @ValidateNested()
    @Type(() => ProbeValidationCipherDto)
    answer: ProbeValidationCipherDto;
}
