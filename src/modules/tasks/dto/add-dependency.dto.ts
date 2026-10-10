import { ApiProperty } from '@nestjs/swagger';
import { IsCuid } from '../../../common/decorators/is-cuid.decorator';

export class AddDependencyDto {
    @ApiProperty({
        example: 'cmgu92m5x0001p8l4h8z6s3k2',
        description:
            'The task CUID that blocks this task (dependencyTaskId). Creates a "blocks" relationship.',
    })
    @IsCuid()
    dependencyTaskId: string;
}
