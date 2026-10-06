import { SetMetadata } from '@nestjs/common';
import { ApiScope } from '../common/scopes';

export const REQUIRE_SCOPES_KEY = 'requireScopes';

/**
 * Declares which API-key scopes are required for a developer API route.
 * Enforced by ApiKeyAuthGuard.
 */
export const RequireScopes = (...scopes: ApiScope[]) =>
    SetMetadata(REQUIRE_SCOPES_KEY, scopes);
