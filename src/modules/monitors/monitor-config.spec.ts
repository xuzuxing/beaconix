import { ValidationPipe } from '@nestjs/common';
import { CreateMonitorDto } from './dto/create-monitor.dto';
import { UpdateMonitorDto } from './dto/update-monitor.dto';
import { validateMonitorConfig } from './monitor-config';

describe('monitor configuration', () => {
    it('defaults DNS to A and normalizes expected sets', () => {
        expect(validateMonitorConfig('DNS')).toEqual({ recordType: 'A' });
        expect(
            validateMonitorConfig('DNS', {
                recordType: 'CNAME',
                expectedValues: ['WWW.Example.COM.', 'www.example.com'],
            }),
        ).toEqual({ recordType: 'CNAME', expectedValues: ['www.example.com'] });
        expect(
            validateMonitorConfig('DNS', {
                recordType: 'AAAA',
                expectedValues: ['2001:4860:4860:0:0:0:0:8888'],
            }),
        ).toEqual({
            recordType: 'AAAA',
            expectedValues: ['2001:4860:4860::8888'],
        });
    });

    it.each([
        ['HTTP', { expectedStatus: 200 }],
        ['TCP', { host: 'localhost' }],
        ['PING', { command: 'anything' }],
        ['DNS', { recordType: 'MX' }],
        ['DNS', { recordType: 'A', expectedValues: ['::1'] }],
        ['DNS', { recordType: 'AAAA', expectedValues: ['1.1.1.1'] }],
        ['DNS', { recordType: 'CNAME', expectedValues: ['a;curl'] }],
        ['DNS', { recordType: 'A', expectedValues: [] }],
        ['DNS', { recordType: 'A', expectedValues: Array(33).fill('1.1.1.1') }],
        ['DNS', { secret: 'not accepted' }],
        ['DNS', null],
        ['DNS', []],
    ] as const)('rejects invalid %s config %j', (type, config) => {
        expect(() => validateMonitorConfig(type, config)).toThrow();
    });

    const pipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
    });
    it.each([null, [], 'string'])(
        'rejects non-object config through ValidationPipe (%j)',
        async (config) => {
            await expect(
                pipe.transform(
                    {
                        name: 'DNS',
                        type: 'DNS',
                        target: 'example.com',
                        config,
                    },
                    { type: 'body', metatype: CreateMonitorDto },
                ),
            ).rejects.toThrow();
            await expect(
                pipe.transform(
                    { config },
                    { type: 'body', metatype: UpdateMonitorDto },
                ),
            ).rejects.toThrow();
        },
    );

    it('accepts DNS through the actual DTO pipeline but rejects unimplemented enums', async () => {
        await expect(
            pipe.transform(
                {
                    name: 'DNS',
                    type: 'DNS',
                    target: 'example.com',
                    config: { recordType: 'A' },
                },
                { type: 'body', metatype: CreateMonitorDto },
            ),
        ).resolves.toBeInstanceOf(CreateMonitorDto);
        await expect(
            pipe.transform(
                {
                    name: 'MQTT',
                    type: 'MQTT',
                    target: 'broker.example.com:1883',
                },
                { type: 'body', metatype: CreateMonitorDto },
            ),
        ).rejects.toThrow();
    });
});
