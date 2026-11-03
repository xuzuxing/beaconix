# Beaconix RUM browser SDK source

`rum-browser.ts` is the dependency-free browser client for:

- `POST /api/rum/errors`
- `POST /api/rum/events`
- `POST /api/rum/replays`

It deliberately uses the public App key only; no secret is embedded in browser
code. Session replay is opt-in and masks text and input values by default.

```ts
const rum = initRum({
    endpoint: 'https://api.example.com/api/rum',
    publicKey: 'rum_public_key',
    release: 'web-2026.11.03.1',
    sessionReplay: {
        enabled: true,
        maskText: true,
        maxPayloadBytes: 48 * 1024,
    },
});

void rum.captureEvent('checkout_completed', { plan: 'pro' });
```

This source is not yet published as an npm package. A consuming frontend can
copy or bundle it directly while the permanent package name and release process
are decided.
