import { ApiProperty } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { IsCuid } from '../../../common/decorators/is-cuid.decorator';

export class MoveTaskToSprintDto {
    @ApiProperty({
        example: 'cmgu92m5x0000p8l4h8z6s3k1',
        description:
            'Sprint CUID to move the task to (null to move to backlog)',
        nullable: true,
    })
    @IsOptional()
    @IsCuid()
    sprintId: string | null;
}
