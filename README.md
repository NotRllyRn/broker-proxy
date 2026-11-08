# Broker Proxy

A real TypeScript account-brokering extension for [ProxyKit](https://github.com/NotRllyRn/proxykit), intended as a small first successor to [Codex Broker](https://github.com/NotRllyRn/codex-broker).

**Implemented and locally tested:** installed Node extension, durable accounts/callers, scoped quota-aware selection, serialized credential refresh, a minimal dashboard, and a separate device-enrollment site. **Not yet verified with a live provider account.** The provider adapter uses `codex app-server`; fixture tests are not OAuth/provider certification. See [capability status and security limits](docs/STATUS.md).

- ProxyKit keeps its existing inference listener and Go transport. This package does not implement a second inference proxy.
- Dashboard defaults to `http://127.0.0.1:8788`; public enrollment defaults to `http://127.0.0.1:8789`.
- Selection follows Codex Broker's **cycle-disabled** rules, not a percentage score or full production-cycle port.
- Dependency-free runtime; Node **24+**. TypeScript and Node declarations are development dependencies only.

## Build and test

Build against the actual ProxyKit SDK, not a vendored imitation. `PROXYKIT_DIR` defaults to `/code/proxykit`. **This version requires the small host correction `ade6cc9`**, committed locally in that checkout but not pushed to ProxyKit's remote. It exposes declared trailer presence to Node; older hosts fail closed. The public baseline alone is insufficient. See [status](docs/STATUS.md) before using another ProxyKit checkout.

```sh
cd /code/broker-proxy
npm ci
npm test
# See docs/STATUS.md for the required host bridge revision.
(cd /code/proxykit && go build -o /tmp/broker-proxy-proxykit ./cmd/proxykit)
npm run test:system
```

`npm test` runs deterministic policy, persistence, provider-process and real web-listener tests. `test:system` uses the **actual CLI GitHub installer**, then the compiled Go proxy and installed Node worker against a local upstream. It needs network access and the tested commit pushed to GitHub. It does not substitute a mocked installer or a local copy. Override `PROXYKIT_BINARY` and `BROKER_TEST_REF` if needed; the default reference is this checkout's `HEAD`. Builds are committed for installation; `npm run build` checks/regenerates them.

## Guided local demonstration — fixtures only

```sh
npm run demo
```

The script installs this commit through ProxyKit's CLI into a disposable extension directory, seeds synthetic credentials, starts a **mock upstream**, then starts ProxyKit with both web services. Nothing calls a live provider. Synthetic demo values are deliberately public:

1. Open **http://127.0.0.1:8788**, sign in with `fixture-demo-admin`. Inspect quota timestamps, disable/enable the account, edit labels, and refresh.
2. Open **http://127.0.0.1:8789**, start device enrollment. It auto-completes after a short fixture delay. **Do not enter the fixture code at OpenAI.** A repeated enrollment is rejected as a duplicate.
3. Send a request through the real ProxyKit listener:

   ```sh
   curl http://127.0.0.1:8080/v1/responses \
     -H 'Authorization: Bearer fixture-demo-caller-012345678901234567890' \
     -H 'Content-Type: application/json' -d '{"input":"fixture"}'
   ```

   Add `"stream":true` to see opaque fixture SSE. This is not a complete emulation of the Responses API.
4. Ctrl-C stops the worker, both sites and the upstream. The script prints its private temporary state directory. Run `BROKER_DEMO_DIR=/that/directory npm run demo` to demonstrate durable account/caller state. Browser sessions intentionally do not survive restart.

All listeners bind loopback. Optional port overrides: `BROKER_DEMO_PROXY_PORT`, `BROKER_DEMO_ADMIN_PORT`, `BROKER_DEMO_ENROLLMENT_PORT`, `BROKER_DEMO_UPSTREAM_PORT`. Never reuse these published fixture secrets or this mock configuration for real accounts.

## Install and configure a private instance

These are operator instructions, **not a claim of live-provider verification or a production deployment**. Use a dedicated OS identity and only trusted installed extensions.

```sh
# Provision a NEW directory, with new random admin/caller secrets and no provider accounts.
node scripts/init.mjs /absolute/new/private-broker

# Pin a reviewed revision when installing; no npm package is required.
proxykit extension install https://github.com/NotRllyRn/broker-proxy --trust

# Restart activates extensions. The environment variable must reach the Node worker.
BROKER_CONFIG=/absolute/new/private-broker/config.json \
  proxykit -listen 127.0.0.1:8080 -upstream https://chatgpt.com -node "$(command -v node)"
```

Read `secrets.json` privately: `admin` signs into the dashboard; `caller` is the data-plane bearer token. The initializer never prints either. Store this file securely or move its contents to your secret manager; never commit it. The application's state holds only digests for caller/admin authentication, but provider credentials necessarily remain in its private state file.

The device flow requires a trusted `codex` executable implementing the inspected app-server protocol. Set `codexCommand` to its absolute path if it is not on PATH. Each operation receives an isolated `HOME`/`CODEX_HOME`, not your normal Codex credentials. Public enrollment requests a provider device code, waits for the matching completion, reads the ChatGPT identity/credential and quota, then commits before activating. It never accepts credentials or administrator privileges from a public form. Protected manual `auth.json` import is a separate dashboard operation, also useful for reauthorizing quarantined accounts.

### Configuration

`BROKER_CONFIG` must be an absolute path to a private regular JSON file (no group/world permissions). Generated configuration contains:

| Key | Default / meaning |
|---|---|
| `dataDir` | Required absolute, private, **dedicated** directory; single writer only |
| `adminHash` | Required SHA-256 hex digest of a high-entropy administrator secret |
| `dashboard` | `{ "host": "127.0.0.1", "port": 8788 }` |
| `enrollment` | `{ "host": "127.0.0.1", "port": 8789 }`; distinct port and origin |
| `enrollmentLabels` | `["Personal usage"]`; assigned by operator, never public visitor |
| `upstream` | `https://chatgpt.com/backend-api/codex`; fixed trusted origin/base path |
| `codexCommand` | `codex`; executable path, not a shell command or argument string |
| `pollMs` | `90000`; one sequential account refresh per tick; `0` disables; otherwise 45,000–86,400,000 |
| `safeFallback` | `false`; opt-in narrow managed safe-method fallback, described below |

The data adapter supports `/v1/responses` and `/v1/models` (also unprefixed equivalents); it does not translate arbitrary OpenAI-compatible APIs. It replaces caller credentials with the selected account's bearer and `Chatgpt-Account-Id`. An optional `X-Broker-Preferred-Account` uses an internal account ID from authenticated `/api/status`, only after scope/reset ordering. Provider behavior at these paths remains live-unverified.

For external access, terminate TLS at a trusted reverse proxy. Configure each listener's exact `origin`, e.g. `"origin":"https://enroll.example.invalid"`, and preserve that Host and browser Origin. Non-loopback binds require an HTTPS origin; **the application itself does not serve TLS**. Keep backend ports firewalled; do not trust arbitrary forwarded headers. HTTPS origins enable Secure cookies. Do not expose the administration site just because enrollment is public. Apply edge admission/rate limits to public enrollment; built-in finite/global limits prevent unbounded work, not denial of service.

## Operational limits

- Treat every installed extension as trusted code. Authentication is extension-owned, **not host `input.auth`**. The host retains the original caller Authorization in the `requested` snapshot. This package does not log it, but cannot conceal it from other trusted hooks. See the concrete host proposal in [STATUS](docs/STATUS.md).
- No POST/inference replay, transport-error retries, rollback after committed output, model fallback, token accounting, response decoration or SSE parsing. Unknown usage stays unknown. Quota snapshots are not token usage.
- Opt-in fallback: one managed child exchange after a 5xx, before response commitment, only GET/HEAD/OPTIONS with an explicit original `Content-Length: 0`, no transfer encoding and no SSE Accept. It authenticates the original caller again, uses normal request/selection hooks and scoped exclusion, and is bounded by ProxyKit's child/body budgets. Many `fetch` implementations remove that GET header and therefore do not qualify. No unlimited fallback or inferred body replay.
- State is atomic JSON with file/directory fsync, private modes, a 32 MiB commit/reopen limit and serialized changes; not an encrypted vault, database cluster, or multi-process store. Refresh ambiguity quarantines credentials rather than reusing possibly rotated tokens. Admission backpressure does not quarantine them.
- Graceful restart releases the lock. After a crash, **stop and verify every process using the directory is gone** before removing only `dataDir/lock`. Never automatically remove a possibly live lock. Restart validates state, quarantines interrupted refresh and removes abandoned extension-owned `runtimes/`. Never point `dataDir` at another application or a real Codex home. Do not delete `state.json` to recover a lock.
- Public sessions expire/cancel and are lost on restart. Cancellation wins while activation is queued; once its serialized transaction begins, durable activation may finish and status reports completed. Cancel does not undo a completed enrollment.

## Provenance

[Implementation plan and source-policy parity](docs/IMPLEMENTATION_PLAN.md) · [test evidence/status](docs/STATUS.md) · [complete assignment](IMPLEMENTATION_PROMPT.md) · [copied reference attribution](reference/README.md).

The Codex Broker reference was inspected, not copied into the new TypeScript implementation. The existing Go reference remains reference material. No license grant was found in the inspected source checkouts; this project does not invent a license or imply permission to redistribute third-party code. No production accounts were migrated, no production service was changed, and no npm package was published.
