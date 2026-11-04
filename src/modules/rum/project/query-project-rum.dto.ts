import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { QueryRumErrorsDto, QueryRumEventsDto } from '../dto';

export class QueryProjectRumErrorsDto extends QueryRumErrorsDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(100)
    appId?: string;
}

export class QueryProjectRumEventsDto extends QueryRumEventsDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(100)
    appId?: string;
}
