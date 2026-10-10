import { Matches, type ValidationOptions } from 'class-validator';

// Prisma CUID v1 is 25-30 characters; the lookahead rejects trailing newlines.
const CUID_PATTERN = /^c[a-z0-9]{24,29}(?![\s\S])/;

export function IsCuid(options?: ValidationOptions): PropertyDecorator {
    return Matches(CUID_PATTERN, {
        message: '$property must be a CUID',
        ...options,
    });
}
