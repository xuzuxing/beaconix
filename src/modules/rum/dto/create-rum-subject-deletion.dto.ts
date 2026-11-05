import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export class CreateRumSubjectDeletionDto {
    @ApiPropertyOptional({
        description: 'End user identifier reported by the SDK',
    })
    @IsOptional()
    @ValidateIf(
        (value: CreateRumSubjectDeletionDto) =>
            value.endUserId !== undefined && value.endUserId !== null,
    )
    @IsString()
    @MaxLength(200)
    endUserId?: string;

    @ApiPropertyOptional({
        description: 'Anonymous identifier reported by the SDK',
    })
    @IsOptional()
    @ValidateIf(
        (value: CreateRumSubjectDeletionDto) =>
            value.anonymousId !== undefined && value.anonymousId !== null,
    )
    @IsString()
    @MaxLength(200)
    anonymousId?: string;
}
