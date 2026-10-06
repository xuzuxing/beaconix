import {
    SCHEDULED_JOB_PATTERNS,
    SCHEDULED_JOBS,
} from './scheduled-jobs.constants';

describe('scheduled job definitions', () => {
    it('defines a pattern for every registered job', () => {
        for (const name of Object.values(SCHEDULED_JOBS)) {
            expect(SCHEDULED_JOB_PATTERNS[name]).toBeTruthy();
        }
    });

    it('only uses five-field patterns', () => {
        for (const [name, pattern] of Object.entries(SCHEDULED_JOB_PATTERNS)) {
            // minute hour day month weekday - the six-field expressions from
            // @nestjs/schedule would silently shift the whole schedule.
            expect({ job: name, fields: pattern.split(' ').length }).toEqual({
                job: name,
                fields: 5,
            });
        }
    });
});
