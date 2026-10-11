import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { MembershipRole } from '../../../generated/prisma/enums';

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
}
