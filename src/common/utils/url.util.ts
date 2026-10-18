/**
 * `@IsUrl()` options for links the platform stores and hands back to a browser
 * (avatar, organization logo/website, external attachment link).
 *
 * Two deviations from the defaults, both deliberate:
 *
 *  - `require_tld: false` — a self-hosted install references `localhost`,
 *    a bare container name (`beacon:3000`) or an intranet host. None of them
 *    carries a TLD, so the default check rejects links that work perfectly.
 *  - `protocols: ['http', 'https']` — the value is later rendered as an
 *    `<img src>`/`<a href>`, so a stored `javascript:` or `file:` URL must never
 *    validate in the first place.
 */
export const BROWSER_URL_OPTIONS = {
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
};
