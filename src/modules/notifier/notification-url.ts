import { isIP } from 'node:net';
import { isPublicAddress } from '../../common/utils/address.util';

/** Static validation also applies to persisted configurations at send time. */
export function parseNotificationUrl(value: string): URL {
    if (!URL.canParse(value)) throw new Error('Invalid notification URL');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Notification URL must use http(s)');
    }
    if (url.username || url.password || url.hash) {
        throw new Error(
            'Notification URL must not contain credentials or a fragment',
        );
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !isPublicAddress(host)) {
        throw new Error('Notification URL must use a public address');
    }
    return url;
}
