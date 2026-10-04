# Contributing to W flow

Thanks for helping! Bug reports, node requests, documentation fixes and pull
requests are all welcome.

## Bug reports

Open an issue with the **Bug report** template: what you did, what you
expected and what happened instead, plus the `BF-xxxx` error code if a node
showed one. While W flow is in beta, **everyone whose bug report helps us fix
something gets a free month of Pro once Pro launches** — mention the e-mail of
your W flow account in the issue or send it to main@w-flow.tech.

Security problems go to main@w-flow.tech, never to a public issue — see
[SECURITY.md](SECURITY.md).

## Pull requests

1. For anything bigger than a small fix, open an issue first so we can agree on
   the approach.
2. Follow the conventions: plain ES modules on the server (no build step),
   double quotes, 2-space indent, semicolons; no vendor SDKs for services
   (plain `fetch`); every user-supplied URL through the SSRF guard
   (`assertPublicHttpUrl`); secrets encrypted with `server/security.js` and
   never logged; engine errors thrown with `attachCode(…)` and a code from
   `shared/errors.js`, mirrored in `ERRORS.md`; comments that explain *why*.
   The SQL Query node stays read-only.
3. Adding or changing a node: a catalog entry in `shared/catalog.js` (or
   `shared/services.js` for plain REST services), a `case` in the `runNode`
   switch of `server/executor.js` when it needs custom code, an icon, and tests
   under `tests/`.
4. Keep CI green: `npm run typecheck`, `npm test` and `npm run build`.
5. Write the commit subject as an imperative sentence that sums up the change.

## Licence of contributions

W flow is licensed under the [Elastic License 2.0](LICENSE). By submitting a
pull request you confirm that you wrote the code (or have the right to submit
it), and you grant the W flow licensor a perpetual, worldwide, royalty-free
licence to use, modify, sublicense and distribute your contribution under the
Elastic License 2.0 **or any other licence**, including a more open one later.
You keep the copyright in your contribution. If you cannot agree to this,
please open an issue describing the change instead of a pull request.
