# Beaconix RUM browser SDK

The dependency-free browser client reports to:

- `POST /api/rum/errors`
- `POST /api/rum/events`
- `POST /api/rum/replays`

The collector follows a Mito-style plugin and breadcrumb model while retaining
Beaconix's own protocol and privacy boundary. JavaScript, unhandled Promise,
resource, failed HTTP, Vue and manual errors create error reports. Successful
HTTP calls, route changes, console calls and clicks are breadcrumbs attached to
the next report.

## Quick start

```ts
import { initRum } from '@beaconix/rum-browser';

const rum = initRum({
    endpoint: 'https://api.example.com/api/rum',
    publicKey: 'rum_public_key',
    release: 'web-2026.11.04.1',
    sessionReplay: false,
});

void rum.captureEvent('checkout_completed', { plan: 'pro' });
void rum.captureMessage('Manual diagnostic error');
```

For Vue 3, install the error handler after creating the application:

```ts
const app = createApp(App);
const uninstallRumVue = rum.installVue(app);
app.mount('#app');
```

`installVue` does not collect component props. It sends only the component name
and Vue's lifecycle/error info string.

## HTTP retry integration

The automatic fetch/XHR plugin sees the browser-level response. If an
application performs token refresh and retries a `401`, either disable automatic
HTTP reporting and call `captureHttpError` from the final Axios error interceptor,
or suppress the intermediate response:

```ts
const rum = initRum({
    endpoint,
    publicKey,
    http: {
        shouldReportError: (context) => context.status !== 401,
    },
});
```

The Beaconix Web request layer should call `captureHttpError` only after its
refresh/retry flow has completed, so the first recoverable `401` is not stored as
an application failure.

## Privacy and recursion controls

- HTTP request and response bodies are never collected.
- URL query strings and fragments are removed.
- Common password, token, authorization, cookie and secret fields are redacted.
- Click breadcrumbs contain selector/coordinates, not element text.
- Console values are bounded and recursively sanitized.
- `/api/rum/**` and the configured endpoint are ignored by HTTP instrumentation.
- Replay remains opt-in and masks text/input values by default.

## Local example page

The example project requires a manually entered endpoint and public key; it does
not contain a real key.

```bash
cd sdk/example
pnpm install --ignore-workspace
pnpm dev
```

It includes buttons for JavaScript errors, unhandled rejections, resource
failures, HTTP failures, Vue errors, manual errors, console/route breadcrumbs and
business events.

This package is local source and is not published to npm yet.
