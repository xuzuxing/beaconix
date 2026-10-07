import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import type { RuleNode } from '../types';

export class CreateRuleGroupDto {
    @ApiProperty({ example: '规则组 G1' })
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    description?: string;

    @ApiPropertyOptional({
        description: '项目级规则组时传入；不传则为组织级',
    })
    @IsOptional()
    @IsString()
    projectId?: string;

    @ApiProperty({
        description: '规则树（LogicNode | ConditionNode），结构由后端递归校验',
    })
    @IsObject()
    tree: RuleNode;
}
