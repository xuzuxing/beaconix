/**
 * Monitoring address guard.
 *
 * The implementation lives in `common/utils/address.util` so the infra layer
 * (`/metrics` admission) can share it without depending on the monitoring
 * modules; this module keeps the checker-facing import path stable.
 */
export {
    assertLiteralPublicAddress,
    assertPublicHost,
    isPublicAddress,
    privateTargetsAllowed,
} from '../../../common/utils/address.util';
export type { AddressVerdict } from '../../../common/utils/address.util';
