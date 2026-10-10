import { ApiProperty } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { IsCuid } from '../../../common/decorators/is-cuid.decorator';

export class AssignTaskDto {
    @ApiProperty({
        example: 'cmgu92m5x0002p8l4h8z6s3k3',
        description: 'User CUID to assign (null to unassign)',
        nullable: true,
    })
    @IsOptional()
    @IsCuid()
    assignedToId: string | null;
}
