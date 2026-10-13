import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    ArrayUnique,
    IsArray,
    IsEmail,
    IsIn,
    IsOptional,
    ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { MembershipRole } from '../../../generated/prisma/enums';
import { ProjectGrantDto } from '../../memberships/dto/project-permissions.dto';

export class CreateInvitationDto {
    @ApiProperty({
        example: 'jane@example.com',
        description: 'Email of the invitee',
    })
    @IsEmail()
    @Transform(({ value }) =>
        typeof value === 'string' ? value.trim().toLowerCase() : value,
    )
    email: string;

    @ApiPropertyOptional({
        enum: ['ADMIN', 'MEMBER', 'VIEWER'],
        default: 'MEMBER',
        description: 'Role to assign upon acceptance',
    })
    @IsOptional()
    @IsIn(['ADMIN', 'MEMBER', 'VIEWER'], {
        message: 'Role must be ADMIN, MEMBER, or VIEWER',
    })
    role?: MembershipRole;

    @ApiPropertyOptional({ type: [ProjectGrantDto], maxItems: 100 })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(100)
    @ArrayUnique((grant: ProjectGrantDto) => grant.projectId)
    @ValidateNested({ each: true })
    @Type(() => ProjectGrantDto)
    projects?: ProjectGrantDto[];
}
