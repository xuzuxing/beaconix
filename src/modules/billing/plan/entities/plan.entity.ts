import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MonitorType } from '../../../../generated/prisma/enums';
import { PlanTermEntity } from './plan-term.entity';

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

    @ApiProperty({ example: 50, description: '0 means no monitor is allowed' })
    maxMonitors: number;

    @ApiProperty({ example: 3, description: '0 means no probe is allowed' })
    maxProbes: number;

    @ApiProperty({
        example: 0,
        description:
            'Probes assignable to a single monitor, clamped by maxProbes. 0 means manual assignment is unavailable.',
    })
    maxProbesPerMonitor: number;

    @ApiProperty({
        example: 5,
        description: '0 means the plan cannot create any API key',
    })
    maxApiKeys: number;

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

    @ApiProperty({
        type: [PlanTermEntity],
        description:
            'Purchasable cycles with their own price. The admin catalog lists disabled terms too; the public catalog only lists enabled ones.',
    })
    terms?: PlanTermEntity[];

    constructor(partial: Partial<PlanEntity>) {
        Object.assign(this, partial);
        // Always an array at runtime: related rows that were not loaded simply
        // yield an empty list.
        const terms = Array.isArray(partial.terms) ? partial.terms : [];
        this.terms = terms.map((term) =>
            term instanceof PlanTermEntity ? term : new PlanTermEntity(term),
        );
    }
}
