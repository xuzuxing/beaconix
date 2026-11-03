# Beaconix RUM browser SDK source

`rum-browser.ts` is the dependency-free V1 browser client for
`POST /api/rum/errors`. It deliberately uses the public App key only; no secret
is embedded in browser code.

This source is not yet published as an npm package. A consuming frontend can
copy or bundle it directly while the permanent package name and release process
are decided.
