import { sanitizeRecord, sanitizeText } from './sanitizer.js';
import type { RumBreadcrumb } from './types.js';

export class BreadcrumbBuffer {
    private readonly entries: RumBreadcrumb[] = [];

    constructor(private readonly capacity = 50) {
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) {
            throw new Error('RUM maxBreadcrumbs must be between 1 and 100');
        }
    }

    add(breadcrumb: Omit<RumBreadcrumb, 'occurredAt'>): void {
        this.entries.push({
            type: sanitizeText(breadcrumb.type, 50),
            ...(breadcrumb.category
                ? { category: sanitizeText(breadcrumb.category, 50) }
                : {}),
            ...(breadcrumb.level ? { level: breadcrumb.level } : {}),
            occurredAt: new Date().toISOString(),
            ...(breadcrumb.data
                ? {
                      data: sanitizeRecord(breadcrumb.data) as Record<
                          string,
                          unknown
                      >,
                  }
                : {}),
        });
        if (this.entries.length > this.capacity) {
            this.entries.splice(0, this.entries.length - this.capacity);
        }
    }

    snapshot(): RumBreadcrumb[] {
        return this.entries.map((entry) => ({
            ...entry,
            ...(entry.data ? { data: { ...entry.data } } : {}),
        }));
    }

    clear(): void {
        this.entries.length = 0;
    }
}
