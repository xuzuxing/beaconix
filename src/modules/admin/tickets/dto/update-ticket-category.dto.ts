import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsInt,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';

export class UpdateTicketCategoryDto {
    @ApiPropertyOptional({ example: 'Billing' })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(50)
    name?: string;

    @ApiPropertyOptional({ example: 'Invoices, plans and payments' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    description?: string;

    @ApiPropertyOptional({ example: 1 })
    @IsOptional()
    @IsInt()
    sortOrder?: number;

    @ApiPropertyOptional({
        example: false,
        description: 'Inactive categories stay on historical tickets only',
    })
    @IsOptional()
    @IsBoolean()
    isActive?: boolean;
}
