import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';

/**
 * Address admission for platform-side monitoring checkers.
 *
 * For **platform-side local checks** private targets are refused: the local
 * executor runs on our servers, so reaching `10/8` or `169.254.169.254` would
 * turn any tenant into an internal network scanner. Probes (which run inside the
 * customer's own network) do not go through this guard — monitoring internal
 * endpoints is exactly what a probe is for.
 *
 * `MONITOR_ALLOW_PRIVATE_TARGETS=true` disables the guard for self-hosted
 * deployments that genuinely monitor their own LAN without probes.
 */
const blocked = new BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 3],
] as const)
    blocked.addSubnet(address, prefix, 'ipv4');

/** Global unicast space; everything outside it is not a public target. */
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('3fff::', 20, 'ipv6');

/** Unwraps IPv4-mapped IPv6 (`::ffff:10.0.0.1`) so it is judged as IPv4. */
function normalizeAddress(address: string): string {
    const trimmed = address.trim();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);

    return mapped ? mapped[1] : trimmed;
}

/** `true` when `address` is a routable public address (v4 or v6). */
export function isPublicAddress(address: string): boolean {
    const candidate = normalizeAddress(address);
    const version = isIP(candidate);

    if (version === 4) return !blocked.check(candidate, 'ipv4');

    return (
        version === 6 &&
        globalV6.check(candidate, 'ipv6') &&
        !blocked.check(candidate, 'ipv6')
    );
}

/** Self-hosted escape hatch; SaaS deployments keep this false. */
export function privateTargetsAllowed(): boolean {
    const raw = process.env.MONITOR_ALLOW_PRIVATE_TARGETS?.trim().toLowerCase();

    return raw === 'true' || raw === '1' || raw === 'yes';
}

export type AddressVerdict = { ok: true } | { ok: false; reason: string };
export interface PinnedAddress {
    address: string;
    family: number;
}
export type ResolvedAddressVerdict =
    ({ ok: true } & PinnedAddress) | { ok: false; reason: string };

/**
 * Resolves once and returns the checked address for the socket to use. Every
 * DNS answer must be public. DNS errors propagate; callers must never fall back
 * to another, unchecked lookup. Private deployments still resolve and pin.
 */
export async function resolvePublicHost(
    hostname: string,
    signal?: AbortSignal,
): Promise<ResolvedAddressVerdict> {
    signal?.throwIfAborted();
    const host = hostname.replace(/^\[|\]$/g, '');
    const allowPrivate = privateTargetsAllowed();
    const family = isIP(host);
    if (family) {
        return allowPrivate || isPublicAddress(host)
            ? { ok: true, address: host, family }
            : { ok: false, reason: 'private or reserved address' };
    }

    const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
        const abort = () => {
            signal?.removeEventListener('abort', abort);
            const reason: unknown = signal?.reason;
            reject(
                reason instanceof Error
                    ? reason
                    : new Error('DNS resolution aborted'),
            );
        };
        signal?.addEventListener('abort', abort, { once: true });
        void lookup(host, { all: true, verbatim: true })
            .then(resolve, reject)
            .finally(() => signal?.removeEventListener('abort', abort));
    });
    signal?.throwIfAborted();
    if (!addresses.length) throw new Error('Hostname resolved to no addresses');

    const offender = !allowPrivate
        ? addresses.find(({ address }) => !isPublicAddress(address))
        : undefined;

    if (offender) {
        return {
            ok: false,
            reason: `resolves to non-public address ${offender.address}`,
        };
    }

    return { ok: true, ...addresses[0] };
}

/** Covers both Node lookup callback shapes without consulting DNS again. */
export function pinnedLookup({
    address,
    family,
}: PinnedAddress): LookupFunction {
    return (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
    };
}

/** Synchronous check for literal addresses (used while saving a monitor). */
export function assertLiteralPublicAddress(host: string): AddressVerdict {
    if (privateTargetsAllowed() || !isIP(host)) return { ok: true };

    return isPublicAddress(host)
        ? { ok: true }
        : { ok: false, reason: 'private or reserved address' };
}
