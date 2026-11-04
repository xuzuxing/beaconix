import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RumErrorGroupEntity {
    @ApiProperty()
    id: string;

    @ApiProperty()
    appId: string;

    @ApiProperty()
    fingerprint: string;

    @ApiProperty()
    fingerprintVersion: number;

    @ApiProperty()
    type: string;

    @ApiPropertyOptional({ nullable: true })
    category: string | null;

    @ApiPropertyOptional({ nullable: true })
    level: string | null;

    @ApiProperty()
    message: string;

    @ApiPropertyOptional({ nullable: true })
    stack: string | null;

    @ApiPropertyOptional({ nullable: true })
    resolvedStack: string | null;

    @ApiPropertyOptional({ nullable: true })
    page: string | null;

    @ApiPropertyOptional({ nullable: true })
    release: string | null;

    @ApiPropertyOptional({ nullable: true })
    replaySessionId: string | null;

    @ApiProperty()
    sourceMapApplied: boolean;

    @ApiProperty()
    count: number;

    @ApiProperty()
    firstSeenAt: Date;

    @ApiProperty()
    lastSeenAt: Date;

    @ApiPropertyOptional({ nullable: true })
    firstOccurredAt: Date | null;

    @ApiPropertyOptional({ nullable: true })
    lastOccurredAt: Date | null;

    @ApiProperty()
    createdAt: Date;

    @ApiProperty()
    updatedAt: Date;
}

export class RumErrorGroupListEntity {
    @ApiProperty({ type: [RumErrorGroupEntity] })
    items: RumErrorGroupEntity[];

    @ApiProperty()
    total: number;

    @ApiProperty()
    page: number;

    @ApiProperty()
    limit: number;
}

export class RumErrorOccurrenceEntity {
    @ApiProperty()
    id: string;

    @ApiProperty()
    appId: string;

    @ApiProperty()
    groupId: string;

    @ApiPropertyOptional({ nullable: true })
    clientEventId: string | null;

    @ApiProperty()
    category: string;

    @ApiProperty()
    level: string;

    @ApiProperty()
    type: string;

    @ApiProperty()
    message: string;

    @ApiPropertyOptional({ nullable: true })
    stack: string | null;

    @ApiPropertyOptional({ nullable: true })
    resolvedStack: string | null;

    @ApiProperty()
    sourceMapApplied: boolean;

    @ApiPropertyOptional({ nullable: true })
    page: string | null;

    @ApiPropertyOptional({ nullable: true })
    release: string | null;

    @ApiPropertyOptional({ nullable: true })
    sessionId: string | null;

    @ApiPropertyOptional({ nullable: true })
    endUserId: string | null;

    @ApiPropertyOptional({ nullable: true })
    anonymousId: string | null;

    @ApiPropertyOptional({ nullable: true })
    requestId: string | null;

    @ApiPropertyOptional({ type: Object, nullable: true })
    http: unknown;

    @ApiPropertyOptional({ type: Object, nullable: true })
    resource: unknown;

    @ApiPropertyOptional({ type: Object, nullable: true })
    vue: unknown;

    @ApiProperty({ type: [Object] })
    breadcrumbs: unknown;

    @ApiPropertyOptional({ type: Object, nullable: true })
    sdk: unknown;

    @ApiPropertyOptional({ nullable: true })
    occurredAt: Date | null;

    @ApiProperty()
    receivedAt: Date;
}

export class RumErrorOccurrenceListEntity {
    @ApiProperty({ type: [RumErrorOccurrenceEntity] })
    items: RumErrorOccurrenceEntity[];

    @ApiProperty()
    total: number;

    @ApiProperty()
    page: number;

    @ApiProperty()
    limit: number;
}
