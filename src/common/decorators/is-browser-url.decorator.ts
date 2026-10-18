import {
    registerDecorator,
    type ValidationOptions,
    ValidatorConstraint,
    type ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'isBrowserUrl', async: false })
export class IsBrowserUrlConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        if (typeof value !== 'string' || value.length === 0) return false;

        let parsed: URL;
        try {
            parsed = new URL(value);
        } catch {
            return false;
        }

        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    }

    defaultMessage(): string {
        return '$property must be an http(s) URL';
    }
}

/**
 * Accepts any absolute http(s) URL, including hosts without a TLD.
 *
 * `@IsUrl()` runs through validator.js, whose `require_tld` default rejects
 * `http://localhost:3000/...` and `http://beacon:3000/...` — exactly the links a
 * self-hosted install stores. Parsing with the WHATWG `URL` keeps the rule
 * predictable regardless of the validator build while still refusing
 * `javascript:` / `file:` values the browser would later execute or open.
 */
export function IsBrowserUrl(options?: ValidationOptions): PropertyDecorator {
    return (target: object, propertyName: string | symbol): void => {
        registerDecorator({
            name: 'isBrowserUrl',
            target: target.constructor,
            propertyName: propertyName as string,
            options,
            validator: IsBrowserUrlConstraint,
        });
    };
}
