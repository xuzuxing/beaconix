import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RumErrorGroupEntity } from '../entities';

export class ProjectRumAppRef {
    @ApiProperty() id: string;
    @ApiProperty() name: string;
}
export class ProjectRumAppOverview extends ProjectRumAppRef {
    @ApiProperty() enabled: boolean;
    @ApiProperty({ description: 'Retained error groups' }) errorGroups: number;
    @ApiProperty({ description: 'Events received in the last seven days' })
    events7d: number;
}
export class ProjectRumOverviewEntity {
    @ApiProperty() appCount: number;
    @ApiProperty({ description: 'Retained error groups' }) errorGroups: number;
    @ApiProperty({ description: 'Events received in the last seven days' })
    events7d: number;
    @ApiProperty() replays: number;
    @ApiProperty() openAlerts: number;
    @ApiProperty({ type: [ProjectRumAppOverview] })
    apps: ProjectRumAppOverview[];
}
export class ProjectRumErrorEntity extends RumErrorGroupEntity {
    @ApiProperty({ type: ProjectRumAppRef }) app: ProjectRumAppRef;
}
export class ProjectRumEventEntity {
    @ApiProperty() id: string;
    @ApiProperty() appId: string;
    @ApiProperty() eventName: string;
    @ApiPropertyOptional({ nullable: true }) endUserId: string | null;
    @ApiPropertyOptional({ nullable: true }) anonymousId: string | null;
    @ApiPropertyOptional({ nullable: true }) sessionId: string | null;
    @ApiPropertyOptional({ nullable: true }) release: string | null;
    @ApiPropertyOptional({ nullable: true }) page: string | null;
    @ApiProperty({ type: 'object', additionalProperties: true })
    properties: Record<string, unknown>;
    @ApiPropertyOptional({ nullable: true }) occurredAt: Date | null;
    @ApiProperty() receivedAt: Date;
    @ApiProperty({ type: ProjectRumAppRef }) app: ProjectRumAppRef;
}
class ProjectRumPageEntity {
    @ApiProperty() total: number;
    @ApiProperty() page: number;
    @ApiProperty() limit: number;
}
export class ProjectRumErrorPageEntity extends ProjectRumPageEntity {
    @ApiProperty({ type: [ProjectRumErrorEntity] })
    items: ProjectRumErrorEntity[];
}
export class ProjectRumEventPageEntity extends ProjectRumPageEntity {
    @ApiProperty({ type: [ProjectRumEventEntity] })
    items: ProjectRumEventEntity[];
}
