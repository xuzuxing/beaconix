import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../../infra/database/prisma.service';
import { ProbeProvider, ProbeScope } from '../../generated/prisma/enums';
import { hashSecret, secretPrefixOf } from './probe-secret.util';

/** Fields needed to provision a system-level probe (scope = SYSTEM). */
export interface SystemProbeInput {
    name: string;
    provider: ProbeProvider;
    region: string;
    callbackUrl: string;
    enabled?: boolean;
    maxTenants?: number;
    priority?: number;
}

/**
 * Creates a system probe plus its initial secret.
 *
 * Shared by the admin CRUD (`SystemProbesService`) and the device-flow approval
 * (`ProbeEnrollmentService.approve` with `scope=SYSTEM`), so both paths store
 * exactly the same shape. The plaintext secret is returned only to the caller
 * and is never persisted.
 */
export async function createSystemProbeRecord(
    prisma: PrismaService,
    input: SystemProbeInput,
) {
    const secret = `sys_${randomBytes(32).toString('hex')}`;

    const probe = await prisma.probe.create({
        data: {
            scope: ProbeScope.SYSTEM,
            organizationId: null,
            name: input.name,
            provider: input.provider,
            region: input.region,
            callbackUrl: input.callbackUrl,
            enabled: input.enabled ?? true,
            maxTenants: input.maxTenants ?? 0,
            priority: input.priority ?? 0,
            secrets: {
                create: {
                    secretHash: hashSecret(secret),
                    secretPrefix: secretPrefixOf(secret),
                },
            },
        },
    });

    return { probe, secret };
}
