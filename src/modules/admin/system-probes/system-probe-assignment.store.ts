import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../infra/redis/redis.service';

const ASSIGNMENT_KEY = 'sys_probe:assignments';
const ASSIGNMENT_TTL_SECONDS = 60 * 60;

export type SystemProbeAssignments = Record<string, string[]>;

@Injectable()
export class SystemProbeAssignmentStore {
    constructor(private readonly redisService: RedisService) {}

    async get(): Promise<SystemProbeAssignments | null> {
        return this.redisService.getJson<SystemProbeAssignments>(
            ASSIGNMENT_KEY,
        );
    }

    async set(assignments: SystemProbeAssignments): Promise<void> {
        await this.redisService.setJson(
            ASSIGNMENT_KEY,
            assignments,
            ASSIGNMENT_TTL_SECONDS,
        );
    }

    async clear(): Promise<void> {
        await this.redisService.del(ASSIGNMENT_KEY);
    }
}
