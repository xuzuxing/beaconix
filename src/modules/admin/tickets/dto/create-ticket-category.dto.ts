import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsInt,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';

export class CreateTicketCategoryDto {
    @ApiProperty({ example: 'Billing' })
    @IsString()
    @MinLength(1)
    @MaxLength(50)
    name: string;

    @ApiPropertyOptional({ example: 'Invoices, plans and payments' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    description?: string;

    @ApiPropertyOptional({ example: 0, default: 0 })
    @IsOptional()
    @IsInt()
    sortOrder?: number;

    @ApiPropertyOptional({ example: true, default: true })
    @IsOptional()
    @IsBoolean()
    isActive?: boolean;
}
