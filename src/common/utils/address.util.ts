import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Address admission shared by the monitoring checkers and the infra layer.
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

/**
 * Vets a host before the platform connects to it: literal addresses are checked
 * directly, domains are resolved and **every** returned address must be public.
 *
 * A resolution failure is not a rejection here — the transport layer reports the
 * real DNS error with its own classification. The remaining (narrow) window is a
 * DNS answer that changes between this check and the socket connect.
 */
export async function assertPublicHost(host: string): Promise<AddressVerdict> {
    if (privateTargetsAllowed()) return { ok: true };

    if (isIP(host)) {
        return isPublicAddress(host)
            ? { ok: true }
            : { ok: false, reason: 'private or reserved address' };
    }

    let addresses: { address: string }[];

    try {
        addresses = await lookup(host, { all: true, verbatim: true });
    } catch {
        return { ok: true };
    }

    if (!addresses.length) return { ok: true };

    const offender = addresses.find(({ address }) => !isPublicAddress(address));

    if (offender) {
        return {
            ok: false,
            reason: `resolves to non-public address ${offender.address}`,
        };
    }

    return { ok: true };
}

/** Synchronous check for literal addresses (used while saving a monitor). */
export function assertLiteralPublicAddress(host: string): AddressVerdict {
    if (privateTargetsAllowed() || !isIP(host)) return { ok: true };

    return isPublicAddress(host)
        ? { ok: true }
        : { ok: false, reason: 'private or reserved address' };
}
