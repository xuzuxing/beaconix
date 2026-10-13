import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayUnique,
    IsArray,
    IsEnum,
    IsInt,
    IsNotEmpty,
    IsString,
    Min,
    ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ProjectRole } from '../../../generated/prisma/enums';

export class ProjectGrantDto {
    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    projectId: string;

    @ApiProperty({ enum: ProjectRole })
    @IsEnum(ProjectRole)
    role: ProjectRole;
}

export class ReplaceProjectPermissionsDto {
    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    expectedMembershipId: string;

    @ApiProperty({ minimum: 0 })
    @IsInt()
    @Min(0)
    expectedVersion: number;

    @ApiProperty({ type: [ProjectGrantDto], maxItems: 100 })
    @IsArray()
    @ArrayMaxSize(100)
    @ArrayUnique((grant: ProjectGrantDto) => grant.projectId)
    @ValidateNested({ each: true })
    @Type(() => ProjectGrantDto)
    projects: ProjectGrantDto[];
}
