import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ProbeHeartbeatDto {
    @ApiPropertyOptional({
        example: 60,
        description:
            'How often this probe calls in. The backend uses it to decide when the probe counts as offline.',
    })
    @IsOptional()
    @IsInt()
    @Min(5)
    @Max(3600)
    intervalSeconds?: number;
}
