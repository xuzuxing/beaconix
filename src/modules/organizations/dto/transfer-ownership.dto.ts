import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';
import { IsCuid } from '../../../common/decorators/is-cuid.decorator';

export class TransferOwnershipDto {
    @ApiProperty({
        example: 'cmgu92m5x0002p8l4h8z6s3k3',
        description: 'User ID of the new owner (must be a member)',
    })
    @IsCuid()
    @IsNotEmpty()
    newOwnerId: string;
}
