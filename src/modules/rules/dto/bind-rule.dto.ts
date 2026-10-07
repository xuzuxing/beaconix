import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { RuleAction } from '../../../generated/prisma/enums';

export class BindRuleDto {
    @ApiProperty({ description: '要绑定的规则组 ID' })
    @IsString()
    ruleGroupId: string;

    @ApiPropertyOptional({ enum: RuleAction, default: RuleAction.ALERT })
    @IsOptional()
    @IsEnum(RuleAction)
    action?: RuleAction;

    @ApiPropertyOptional({ description: '优先级，越大越先求值', default: 0 })
    @IsOptional()
    @IsInt()
    priority?: number;
}
