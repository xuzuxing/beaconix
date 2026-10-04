import type { NotificationPayload } from './notifier.types';

/** Short headline, e.g. "[DOWN] Production API". */
export function renderTitle(payload: NotificationPayload): string {
    if (payload.event === 'RECOVER') {
        return `[RECOVERED] ${payload.monitorName}`;
    }
    return `[${payload.status}] ${payload.monitorName}`;
}

function detailLines(payload: NotificationPayload): string[] {
    const lines = [
        `Target: ${payload.target}`,
        `Status: ${payload.previousStatus} -> ${payload.status}`,
        `Checked at: ${payload.checkedAt.toISOString()}`,
    ];

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
    const status =
        payload.event === 'RECOVER'
            ? `**${payload.status}**`
            : `**${payload.status}** (was ${payload.previousStatus})`;

    const lines = [
        `### ${renderTitle(payload)}`,
        `**Target:** ${payload.target}`,
        `**Status:** ${status}`,
    ];

    if (payload.latency !== null) {
        lines.push(`**Latency:** ${payload.latency}ms`);
    }
    if (payload.error) {
        lines.push(`**Error:** ${payload.error}`);
    }
    if (payload.failCount > 0) {
        lines.push(`**Consecutive failures:** ${payload.failCount}`);
    }

    lines.push(`**Checked at:** ${payload.checkedAt.toISOString()}`);

    return lines.join('\n');
}
