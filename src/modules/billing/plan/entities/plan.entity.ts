import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MonitorType } from '../../../../generated/prisma/enums';

export class PlanEntity {
    @ApiProperty({ enum: MonitorType, isArray: true })
    allowedMonitorTypes: MonitorType[];
    @ApiProperty({ example: 'uuid-plan' })
    id: string;

    @ApiProperty({ example: 'PRO' })
    code: string;

    @ApiProperty({ example: '专业版' })
    name: string;

    @ApiPropertyOptional({ example: 'For small teams' })
    description: string | null;

    @ApiProperty({ example: 2900, description: 'Monthly price in cents' })
    price: number;

    @ApiProperty({ example: 30 })
    durationDays: number;

    @ApiProperty({ example: 2 })
    sortOrder: number;

    @ApiProperty({ example: 50 })
    maxMonitors: number;

    @ApiProperty({ example: 3 })
    maxProbes: number;

    @ApiProperty({ example: 10 })
    maxMembers: number;

    @ApiProperty({ example: 5 })
    maxChannels: number;

    @ApiProperty({ example: 60 })
    minInterval: number;

    @ApiProperty({ example: true })
    allowTenantProbe: boolean;

    @ApiProperty({ example: true })
    allowStatusPage: boolean;

    @ApiProperty({ example: true })
    enabled: boolean;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    createdAt: Date;

    @ApiProperty({ example: '2026-03-05T12:00:00.000Z' })
    updatedAt: Date;

    constructor(partial: Partial<PlanEntity>) {
        Object.assign(this, partial);
    }
}
