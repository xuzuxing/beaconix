import { AlertEventsService } from './alert-events.service';
import type { PrismaService } from '../../infra/database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type {
    MonitorModel,
    MonitorStateModel,
} from '../../generated/prisma/models';
import type { CheckOutcome } from '../state/state.service';
import type { NotificationsService } from '../notifications/notifications.service';

const monitor = {
    id: 'm',
    projectId: 'p',
    organizationId: 'o',
    name: 'API',
    target: 'https://example.test',
    type: 'HTTP',
    failureThreshold: 3,
    availabilityEnabled: true,
    availabilityThreshold: 90,
    availabilityWindow: 10,
    checkSsl: true,
    sslExpiryThreshold: 30,
    revision: 2,
    configRevision: 3,
} as MonitorModel;
function fixture() {
    const tx = {
        alertEvent: {
            findFirst: jest.fn(),
            create: jest.fn().mockImplementation(({ data }) => ({
                ...data,
                id: 'event',
                lifecycleRevision: 1,
            })),
            update: jest.fn().mockImplementation(({ data }) => ({
                ...data,
                id: 'event',
                lifecycleRevision: 2,
            })),
        },
        alertDelivery: {
            create: jest.fn(),
            findMany: jest.fn().mockResolvedValue([{ channelId: 'c' }]),
        },
        checkLog: { findMany: jest.fn().mockResolvedValue([]) },
        monitorNotificationChannel: {
            findMany: jest.fn().mockResolvedValue([]),
        },
        notificationChannel: {
            findMany: jest.fn().mockResolvedValue([{ id: 'c' }]),
        },
        notification: {
            findMany: jest.fn().mockResolvedValue([{ userId: 'owner' }]),
        },
    };
    const notifications = {
        publish: jest.fn().mockResolvedValue(undefined),
        organizationRecipients: jest.fn().mockResolvedValue(['owner']),
        eventRecipients: jest.fn().mockResolvedValue(['owner']),
    };
    const service = new AlertEventsService(
        {} as PrismaService,
        notifications as unknown as NotificationsService,
    );
    const record = (
        outcome: Partial<CheckOutcome>,
        overrides = {},
        previous = {},
    ) =>
        service.record(
            tx as unknown as Prisma.TransactionClient,
            { ...monitor, ...overrides },
            {
                status: 'UP',
                availabilityAlertActive: false,
                ...previous,
            } as MonitorStateModel,
            {
                success: false,
                latency: 5000,
                serviceVerdict: 'NO_EVIDENCE',
                ...outcome,
            },
            { status: 'DOWN', failCount: 3, connectivityFailCount: 3 },
        );
    return { tx, record, notifications };
}
describe('Alert events', () => {
    it('publishes a private station opening in the incident transaction', async () => {
        const { tx, record, notifications } = fixture();
        await record({ serviceVerdict: 'FAILURE', failureReason: 'TIMEOUT' });
        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                eventKey: 'monitor-incident:event:OPEN',
                type: 'MONITOR_ALERT',
                recipients: ['owner'],
                organizationId: 'o',
                resourceType: 'Monitor',
                resourceId: 'm',
                meta: {
                    alertEventId: 'event',
                    kind: 'CONNECTIVITY',
                    projectId: 'p',
                },
            }),
            tx,
        );
        expect(JSON.stringify(notifications.publish.mock.calls)).not.toContain(
            monitor.target,
        );
    });

    it('sends station recovery only to the opening recipients', async () => {
        const { tx, record, notifications } = fixture();
        tx.alertEvent.findFirst.mockResolvedValueOnce({
            id: 'event',
            startedAt: new Date(0),
            origin: 'LIVE',
        });
        tx.notification.findMany.mockResolvedValue([]);
        notifications.eventRecipients.mockResolvedValue(['previous-recipient']);
        await record({ serviceVerdict: 'SUCCESS' });
        expect(notifications.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'MONITOR_RECOVERED',
                recipients: ['previous-recipient'],
                eventKey: 'monitor-incident:event:RECOVERY',
            }),
            tx,
        );
        expect(notifications.organizationRecipients).not.toHaveBeenCalled();
        expect(notifications.eventRecipients).toHaveBeenCalledWith(
            'monitor-incident:event:OPEN',
            tx,
        );
    });

    it('does not turn a baseline incident into a station opening', async () => {
        const { tx, record, notifications } = fixture();
        tx.alertEvent.findFirst.mockResolvedValueOnce({
            id: 'baseline',
            origin: 'BASELINE',
            startedAt: new Date(0),
        });
        await record({ serviceVerdict: 'FAILURE' });
        expect(notifications.publish).not.toHaveBeenCalled();
    });

    it('opens connectivity independently of an existing SSL DOWN state', async () => {
        const { tx, record } = fixture();
        await record(
            { serviceVerdict: 'FAILURE', failureReason: 'TIMEOUT' },
            {},
            { status: 'DOWN' },
        );
        expect(tx.alertEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                kind: 'CONNECTIVITY',
                reason: 'TIMEOUT',
                level: 'critical',
            }),
        });
        expect(tx.alertDelivery.create).toHaveBeenCalledTimes(1);
        expect(tx.alertDelivery.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                payload: expect.objectContaining({
                    monitorRevision: 2,
                    monitorConfigRevision: 3,
                }),
            }),
        });
    });
    it('does not invent service failure from pure SSL evidence', async () => {
        const { tx, record } = fixture();
        await record({ sslVerdict: 'INVALID' });
        expect(tx.alertEvent.create).toHaveBeenCalledTimes(1);
        expect(tx.alertEvent.create.mock.calls[0][0].data.kind).toBe('SSL');
    });
    it('recovers connectivity without recovering an invalid certificate', async () => {
        const { tx, record } = fixture();
        tx.alertEvent.findFirst
            .mockResolvedValueOnce({
                id: 'connectivity',
                startedAt: new Date(0),
                firstNotifiedAt: new Date(),
            })
            .mockResolvedValueOnce({ id: 'ssl', startedAt: new Date(0) });
        await record({ serviceVerdict: 'SUCCESS', sslVerdict: 'INVALID' });
        expect(tx.alertEvent.update).toHaveBeenCalledWith({
            where: { id: 'connectivity' },
            data: expect.objectContaining({ status: 'resolved' }),
        });
        expect(tx.alertEvent.update).toHaveBeenCalledWith({
            where: { id: 'ssl' },
            data: expect.not.objectContaining({ status: 'resolved' }),
        });
    });
    it('keeps low availability ongoing when only the consecutive streak improves', async () => {
        const { tx, record } = fixture();
        tx.checkLog.findMany.mockResolvedValue([
            { ruleMatched: false },
            { ruleMatched: true },
            { ruleMatched: true },
        ]);
        const result = await record(
            { success: true },
            {},
            { availabilityAlertActive: true },
        );
        expect(result.availabilityAlertActive).toBe(true);
        expect(tx.alertEvent.update).not.toHaveBeenCalled();
    });
    it('records rule-health evidence and creates a single logical opening', async () => {
        const { tx, record } = fixture();
        tx.checkLog.findMany.mockResolvedValue(
            Array.from({ length: 3 }, () => ({ ruleMatched: true })),
        );
        await record({
            ruleEvidence: [{ groupId: 'rules', reason: 'SLOW_RESPONSE' }],
        });
        expect(tx.checkLog.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { monitorId: 'm', evaluated: true, revision: 2 },
            }),
        );
        expect(tx.alertEvent.create.mock.calls[0][0].data).toMatchObject({
            kind: 'AVAILABILITY',
            reason: 'AVAILABILITY_LOW',
            latestEvidence: {
                details: {
                    basis: 'RULE_HEALTHY',
                    sampleSize: 3,
                    consecutive: 3,
                },
            },
        });
        tx.alertEvent.findFirst.mockResolvedValue({
            id: 'event',
            startedAt: new Date(0),
        });
        await record({ ruleEvidence: [] });
        expect(tx.alertEvent.create).toHaveBeenCalledTimes(1);
        expect(tx.alertDelivery.create).toHaveBeenCalledTimes(1);
    });
    it('retains a recovery intent while the opening is still in flight', async () => {
        const { tx, record } = fixture();
        tx.alertEvent.findFirst.mockResolvedValue({
            id: 'event',
            startedAt: new Date(0),
            firstNotifiedAt: null,
        });
        await record(
            { serviceVerdict: 'SUCCESS' },
            { availabilityEnabled: false, checkSsl: false },
        );
        expect(tx.alertDelivery.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ phase: 'RECOVERY' }),
        });
    });
    it('does not announce the first UNKNOWN baseline', async () => {
        const { tx, record } = fixture();
        await record(
            { serviceVerdict: 'FAILURE' },
            { availabilityEnabled: false, checkSsl: false },
            { status: 'UNKNOWN' },
        );
        expect(tx.alertEvent.create).toHaveBeenCalled();
        expect(tx.alertDelivery.create).not.toHaveBeenCalled();
    });
    it('announces a continuing first-check outage on the next eligible check only once', async () => {
        const { tx, record } = fixture();
        await record(
            { serviceVerdict: 'FAILURE' },
            { availabilityEnabled: false, checkSsl: false },
            { status: 'UNKNOWN' },
        );
        tx.alertEvent.findFirst.mockResolvedValue({
            id: 'event',
            origin: 'OBSERVED',
            lifecycleRevision: 1,
        });
        tx.alertDelivery.findMany.mockResolvedValueOnce([]);
        await record(
            { serviceVerdict: 'FAILURE' },
            { availabilityEnabled: false, checkSsl: false },
            { status: 'DOWN' },
        );
        expect(tx.alertEvent.create).toHaveBeenCalledTimes(1);
        expect(tx.alertDelivery.create).toHaveBeenCalledTimes(1);
        await record(
            { serviceVerdict: 'FAILURE' },
            { availabilityEnabled: false, checkSsl: false },
            { status: 'DOWN' },
        );
        expect(tx.alertDelivery.create).toHaveBeenCalledTimes(1);
    });
});
