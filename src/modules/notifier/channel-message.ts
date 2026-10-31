import { toIsoString } from '../../common/utils/date.util';
import type { NotificationPayload } from './notifier.types';

/** Short headline, e.g. "[DOWN] Production API". */
export function renderTitle(payload: NotificationPayload): string {
    const prefix = payload.test ? '[TEST] ' : '';

    if (payload.event === 'NO_DATA')
        return `${prefix}[NO DATA] ${payload.monitorName}`;
    if (payload.event === 'NO_DATA_RECOVERED')
        return `${prefix}[OBSERVATIONS RESUMED] ${payload.monitorName}`;

    if (payload.event === 'AVAILABILITY_RECOVERED') {
        return `${prefix}[AVAILABILITY RECOVERED] ${payload.monitorName}`;
    }
    if (payload.event === 'AVAILABILITY_ALERT') {
        return `${prefix}[LOW AVAILABILITY] ${payload.monitorName}`;
    }
    if (payload.event === 'RECOVER') {
        return `[RECOVERED] ${payload.monitorName}`;
    }
    return `[${payload.status}] ${payload.monitorName}`;
}

function isAvailabilityEvent(payload: NotificationPayload): boolean {
    return (
        payload.event === 'AVAILABILITY_ALERT' ||
        payload.event === 'AVAILABILITY_RECOVERED'
    );
}

function isNoDataEvent(payload: NotificationPayload): boolean {
    return payload.event === 'NO_DATA' || payload.event === 'NO_DATA_RECOVERED';
}

function timeLabel(payload: NotificationPayload): string {
    return payload.event === 'NO_DATA'
        ? 'Detected at'
        : payload.event === 'NO_DATA_RECOVERED'
          ? 'Observation at'
          : 'Checked at';
}

/** One-line availability summary, or null when the alert carries no figures. */
function availabilityLine(payload: NotificationPayload): string | null {
    if (payload.availabilityPercent === undefined) return null;

    const sample = payload.availabilitySampleSize ?? payload.availabilityWindow;
    const sampleSuffix =
        sample !== undefined ? ` over last ${sample} checks` : '';
    const comparator = payload.event === 'AVAILABILITY_RECOVERED' ? '>=' : '<';

    return `Availability: ${payload.availabilityPercent}% (${comparator} ${payload.availabilityThreshold}%${sampleSuffix})`;
}

function detailLines(payload: NotificationPayload): string[] {
    const lines = [`Target: ${payload.target}`];

    if (isNoDataEvent(payload)) {
        lines.push(`Status: ${payload.status}`);
    } else if (isAvailabilityEvent(payload)) {
        const availability = availabilityLine(payload);
        if (availability) lines.push(availability);
        lines.push(`Status: ${payload.status}`);
    } else {
        lines.push(`Status: ${payload.previousStatus} -> ${payload.status}`);
    }

    lines.push(`${timeLabel(payload)}: ${toIsoString(payload.checkedAt)}`);

    if (payload.latency !== null) {
        lines.push(`Latency: ${payload.latency}ms`);
    }
    if (payload.error) {
        lines.push(`Error: ${payload.error}`);
    }
    if (payload.failCount > 0) {
        lines.push(`Consecutive failures: ${payload.failCount}`);
    }

    return lines;
}

/** Plain-text rendering, used by webhooks that take a text body. */
export function renderText(payload: NotificationPayload): string {
    return [renderTitle(payload), ...detailLines(payload)].join('\n');
}

/** Markdown rendering, used by the WeCom / DingTalk robots. */
export function renderMarkdown(payload: NotificationPayload): string {
    const lines = [
        `### ${renderTitle(payload)}`,
        `**Target:** ${payload.target}`,
    ];

    if (isNoDataEvent(payload)) {
        lines.push(`**Status:** **${payload.status}**`);
    } else if (isAvailabilityEvent(payload)) {
        const availability = availabilityLine(payload);
        if (availability) lines.push(`**${availability}**`);
        lines.push(`**Status:** **${payload.status}**`);
    } else {
        const status =
            payload.event === 'RECOVER'
                ? `**${payload.status}**`
                : `**${payload.status}** (was ${payload.previousStatus})`;
        lines.push(`**Status:** ${status}`);
    }

    if (payload.latency !== null) {
        lines.push(`**Latency:** ${payload.latency}ms`);
    }
    if (payload.error) {
        lines.push(`**Error:** ${payload.error}`);
    }
    if (payload.failCount > 0) {
        lines.push(`**Consecutive failures:** ${payload.failCount}`);
    }

    lines.push(`**${timeLabel(payload)}:** ${toIsoString(payload.checkedAt)}`);

    return lines.join('\n');
}
