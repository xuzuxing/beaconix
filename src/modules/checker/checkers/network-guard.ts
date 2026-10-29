/**
 * Monitoring address guard.
 *
 * Common address validation and DNS pinning for local monitor transports.
 */
export {
    assertLiteralPublicAddress,
    resolvePublicHost,
    pinnedLookup,
    isPublicAddress,
    privateTargetsAllowed,
} from '../../../common/utils/address.util';
export type {
    AddressVerdict,
    PinnedAddress,
} from '../../../common/utils/address.util';
