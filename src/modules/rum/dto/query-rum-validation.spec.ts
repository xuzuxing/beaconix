import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { QueryRumAlertIncidentsDto } from './query-rum-alert-incidents.dto';
import {
    QueryRumEventsDto,
    QueryRumEventStatsDto,
} from './query-rum-events.dto';
import {
    QueryRumReplaysDto,
    QueryRumReplayChunksDto,
} from './query-rum-replays.dto';
import { QueryProjectRumEventsDto } from '../project/query-project-rum.dto';

describe('RUM query validation', () => {
    const pipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: false,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
    });
    const convert = (metatype: new () => object, value: object) =>
        pipe.transform(value, { type: 'query', metatype });

    it.each([
        [
            QueryRumAlertIncidentsDto,
            { status: 'OPEN', page: '1', limit: '5' },
            { status: 'OPEN', page: 1, limit: 5 },
        ],
        [QueryRumEventsDto, { page: '1', limit: '5' }, { page: 1, limit: 5 }],
        [
            QueryProjectRumEventsDto,
            { appId: 'app', page: '1', limit: '5' },
            { appId: 'app', page: 1, limit: 5 },
        ],
        [QueryRumEventStatsDto, { days: '7' }, { days: 7 }],
        [QueryRumReplaysDto, { page: '1', limit: '5' }, { page: 1, limit: 5 }],
        [
            QueryRumReplayChunksDto,
            { afterSequence: '-1', limit: '50' },
            { afterSequence: -1, limit: 50 },
        ],
    ])('converts HTTP query strings for %s', async (dto, query, expected) => {
        await expect(convert(dto, query)).resolves.toMatchObject(expected);
    });

    it.each([
        [QueryRumAlertIncidentsDto, { page: 1, limit: 20 }],
        [QueryRumEventsDto, { page: 1, limit: 20 }],
        [QueryProjectRumEventsDto, { page: 1, limit: 20 }],
        [QueryRumEventStatsDto, { days: 7 }],
        [QueryRumReplaysDto, { page: 1, limit: 20 }],
        [QueryRumReplayChunksDto, { afterSequence: -1, limit: 50 }],
    ])('preserves defaults for %s', async (dto, expected) => {
        await expect(convert(dto, {})).resolves.toMatchObject(expected);
    });

    it.each([
        [QueryRumAlertIncidentsDto, { page: '0' }],
        [QueryRumEventsDto, { limit: '101' }],
        [QueryProjectRumEventsDto, { page: '1.5' }],
        [QueryRumEventStatsDto, { days: '91' }],
        [QueryRumReplaysDto, { page: 'abc' }],
        [QueryRumReplayChunksDto, { afterSequence: '-2' }],
        [QueryRumReplayChunksDto, { limit: '0' }],
    ])('rejects invalid queries for %s', async (dto, query) => {
        await expect(convert(dto, query)).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });
});
