# Security policy

W flow stores other people's credentials, runs their code and calls the
internet on their behalf, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

E-mail **main@w-flow.tech** with:

- what the problem is and what an attacker could do with it,
- the steps to reproduce it (a request, a workflow JSON, a screenshot),
- the version or commit you tested.

You will get an answer within a few days. Please give us reasonable time to fix
the problem before you talk about it publicly; we will credit you in the fix
unless you prefer not to be named.

## Scope

In scope: this repository and the hosted service at w-flow.tech — for example
authentication, workflow or credential access across accounts, the code
sandbox, the SSRF guard, webhooks, the admin panel and the licence check.

Out of scope: denial of service by sheer volume, reports from automated
scanners without a working proof, and problems in third-party services W flow
connects to.

Please test only against your own account or your own self-hosted copy, and
never access or change other users' data.

## Self-hosting checklist

Set `BF_ENCRYPTION_KEY`, `BF_ADMIN_USERNAME` and `BF_ADMIN_PASSWORD` in `.env`,
keep the admin panel on `127.0.0.1` (reach it through an SSH tunnel), turn on
`BF_BLOCK_PRIVATE_URLS=1` on a public server and keep the copy updated. The
README's production checklist has the full list.
