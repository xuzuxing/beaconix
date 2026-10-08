import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString } from 'class-validator';

export class BindRuleDto {
    @ApiProperty({ description: '要绑定的规则组 ID' })
    @IsString()
    ruleGroupId: string;

    @ApiPropertyOptional({ description: '优先级，越大越先求值', default: 0 })
    @IsOptional()
    @IsInt()
    priority?: number;
}
