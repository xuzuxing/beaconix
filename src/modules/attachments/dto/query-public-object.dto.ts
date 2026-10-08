import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class QueryPublicObjectDto {
    @ApiProperty({
        example: 'openchoreo/2026/10/object-file.png',
    })
    @IsString()
    @MaxLength(1024)
    key: string;

    @ApiPropertyOptional({ enum: ['LOCAL', 'OSS'], example: 'LOCAL' })
    @IsOptional()
    @IsEnum(['LOCAL', 'OSS'])
    provider?: 'LOCAL' | 'OSS';

    @ApiPropertyOptional({ example: 'beacon-attachments' })
    @IsOptional()
    @IsString()
    @MaxLength(512)
    bucket?: string;
}
