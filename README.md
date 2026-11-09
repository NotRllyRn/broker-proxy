# Broker Proxy

A real TypeScript account-brokering extension for [ProxyKit](https://github.com/NotRllyRn/proxykit), intended as a small first successor to [Codex Broker](https://github.com/NotRllyRn/codex-broker).

**Implemented and locally tested:** installed Node extension, durable accounts/callers, scoped quota-aware selection, serialized credential refresh, account-specific inference pulses and reset scheduling, a minimal dashboard with per-account observations/counters, and a separate device-enrollment site. **Not yet verified with a live provider account.** The provider adapter uses `codex app-server`; fixture tests are not OAuth/provider certification. See [capability status and security limits](docs/STATUS.md).

- ProxyKit keeps its existing inference listener and Go transport. This package does not implement a second inference proxy.
- Dashboard defaults to `http://127.0.0.1:8788`; public enrollment defaults to `http://127.0.0.1:8789`.
- Selection follows Codex Broker's **cycle-disabled** rules, not a percentage score or full production-cycle port.
- Dependency-free JavaScript runtime; Node **24+**. The broker installs its own pinned official Codex CLI using **npm 10+**, not a globally installed `codex`. TypeScript and Node declarations are development dependencies only.

## Build and test

Source, SDK and host binary compatibility are pinned to published ProxyKit **`0559b73e2bb35961fc33577d72c39cd4ac7933ca`** ([source](https://github.com/NotRllyRn/proxykit/tree/0559b73e2bb35961fc33577d72c39cd4ac7933ca)). It includes install-created persistent storage and setup `api.dataDir`, trailer visibility and hot activation with shutdown store-lock protection; **no private host patch is required**. Build against that actual SDK, not a vendored imitation. `PROXYKIT_SOURCE` defaults to `/code/proxykit`; explicitly select a clean pinned archive if that shared checkout differs. Manifest `apiVersion: 1` is required independently of `manifestVersion: 1`.

```sh
cd /code/broker-proxy
# Read-only use of the shared repository; never reset/clean its active checkout.
export PROXYKIT_REV=0559b73e2bb35961fc33577d72c39cd4ac7933ca
export PROXYKIT_SOURCE="$(mktemp -d /tmp/broker-proxykit-source-XXXXXX)"
git -C /code/proxykit archive "$PROXYKIT_REV" | tar -x -C "$PROXYKIT_SOURCE"
export PROXYKIT_BINARY=/tmp/broker-proxy-proxykit
(cd "$PROXYKIT_SOURCE" && go build -o "$PROXYKIT_BINARY" ./cmd/proxykit)
npm ci
npm test
# Optional network test: real pinned CLI install/version/schema/initialize, no account or login.
npm run test:codex
npm run test:system
```

`npm test` runs deterministic policy, persistence, provider-process and real web-listener tests. `test:system` uses the **actual CLI GitHub installer for the broker**, checks the install-created empty directory, then runs two account-free default boots with automatic initialization and no `BROKER_CONFIG`. It subsequently edits that disposable config while stopped to select synthetic upstream/provider fixtures for lifecycle/pulse testing. It needs network access and the tested commit pushed to GitHub. Only an unrelated response-header fixture uses the real Installer with controlled archive transport; its Go dependency is pinned to the same published host revision in `test/activation-fixture/go.mod` (no local replacement). Live enable/disable must preserve the broker PID, both listener sockets, locks, admin session and account/pulse state; shutdown must release listeners, worker and locks. These system assertions require **Linux `/proc`, `flock` and Go >=1.26** (other platforms skip this test). Override `PROXYKIT_BINARY` and `BROKER_TEST_REF` if needed; the default reference is this checkout's full `HEAD`. Builds are committed for installation; `npm run build` checks/regenerates them. See [exact verification evidence](docs/STATUS.md).

## Guided local demonstration — fixtures only

```sh
npm run demo
```

The script installs this commit through ProxyKit's CLI into a disposable extension directory and uses the shared initializer in the host-created storage. It deliberately substitutes fixture configuration/credentials while stopped, explicitly enables `broker-proxy` offline, starts a **mock upstream**, then starts ProxyKit with both web services. Nothing calls a live provider. Synthetic demo values are deliberately public:

1. Open **http://127.0.0.1:8788**, sign in with `fixture-demo-admin`. Inspect stored quota/freshness, per-account counters and pulse status. **Refresh quota** does not send inference; **Pulse (uses inference)** runs a synthetic account-specific turn. Enable automatic pulses in the small settings form to schedule initial/window pulses; use a newly enrolled fixture account to see an initial scheduled pulse without waiting for a future reset. The fixture does not contact OpenAI. Disable automatic pulses again to demonstrate durable settings.
2. Open **http://127.0.0.1:8789**, start device enrollment. It auto-completes after a short fixture delay. **Do not enter the fixture code at OpenAI.** A repeated enrollment is rejected as a duplicate.
3. Send a request through the real ProxyKit listener:

   ```sh
   curl http://127.0.0.1:8080/v1/responses \
     -H 'Authorization: Bearer fixture-demo-caller-012345678901234567890' \
     -H 'Content-Type: application/json' -d '{"input":"fixture"}'
   ```

   Add `"stream":true` to see opaque fixture SSE. This is not a complete emulation of the Responses API.
4. Ctrl-C stops the worker, both sites and the upstream. The script prints its private temporary state directory. Run `BROKER_DEMO_DIR=/that/directory npm run demo` to demonstrate durable account/caller state. Browser sessions intentionally do not survive restart; quota observations, pulse outcomes/settings and counters do.

All listeners bind loopback. Optional port overrides: `BROKER_DEMO_PROXY_PORT`, `BROKER_DEMO_ADMIN_PORT`, `BROKER_DEMO_ENROLLMENT_PORT`, `BROKER_DEMO_UPSTREAM_PORT`. Never reuse these published fixture secrets or this mock configuration for real accounts.

## Install and configure a private instance

These are operator instructions, **not a claim of live-provider verification or a production deployment**. Use a dedicated OS identity and only trusted installed extensions.

```sh
# Use this same explicit store and OS user for all management/server commands.
export PROXYKIT_EXTENSIONS_DIR="$HOME/.local/share/proxykit/extensions"

# Pin a reviewed revision when installing; no npm package is required.
proxykit extension install https://github.com/NotRllyRn/broker-proxy --trust
# Install creates private storage but persists DISABLED; offline enable saves intent.
proxykit extension enable broker-proxy
proxykit -listen 127.0.0.1:8080 -upstream https://chatgpt.com -node "$(command -v node)"
```

No directory preparation, manual initializer or `BROKER_CONFIG` is required. Installation creates/validates private `<store>/.data/broker-proxy`; first setup initializes config, random admin/caller secrets and a `data/` state child. No accounts are enrolled and automatic inference stays OFF. Later setup reuses these files without rotating credentials. Identity is the unique manifest ID `broker-proxy`, not its display label or version; one installation per ID. The host's `.owner-lock` and `.data/` root remain separate from the broker's `data/lock`. On an **already running** server, `proxykit extension enable broker-proxy` activates without restarting; alternatively `extension install URL --trust --activate` now works with automatic initialization. `--activate` requires a running server: offline it returns an error and leaves the package installed but disabled. `extension status broker-proxy` separates persisted enabled intent from runtime status. For code replacement, disable → wait for drain/cleanup/reaping → remove → install the reviewed revision → enable; never overlap stateful owners or edit host installation files. See the pinned [activation contract](https://github.com/NotRllyRn/proxykit/blob/0559b73e2bb35961fc33577d72c39cd4ac7933ca/docs/HOT_ACTIVATION.md).

After first setup, read **`$PROXYKIT_EXTENSIONS_DIR/.data/broker-proxy/secrets.json`** on a private terminal under the same OS user: `admin` signs into the dashboard; `caller` is the data-plane bearer token. This is a known store-path pattern, not a discovery command. Generated secrets are 0600, never printed in setup logs or returned by status/GET endpoints. Keep the file private and backed up (it is required to validate complete default initialization); you may also copy its values into your secret manager. Never paste it into chat or commit it. Config/state contain authentication digests, but provider credentials necessarily remain in private `data/state.json`.

Data survives disable, shutdown, package removal and reinstall/version replacement; removal does **not** erase credentials. Back up the host-owned directory while stopped. The host validates private ownership/0700 directories; Broker also rejects unsafe/symlink config, secrets and state. Trusted ancestors and same-UID code remain the security boundary, not a filesystem sandbox. Configurable ports still default to 8788/8789; there is no automatic multi-instance port allocation.

**Interrupted initialization:** `.initializing` is an exclusive marker, separate from the runtime store lock. Files are created exclusively and synced, config last; an error leaves the marker/partial files intact. Setup reports `BROKER_INIT_IN_PROGRESS_OR_INCOMPLETE` or `BROKER_INIT_INCOMPLETE` rather than adopting partial state or regenerating credentials. Stop/disable all owners, then restore a complete known-good backup, or explicitly archive the **entire** `.data/broker-proxy` directory outside `.data/` and enable again to let the host create a fresh directory. A fresh start generates new credentials and loses access to the archived state until deliberately restored. Do not just delete the marker or individual files to bypass validation. This is conservative crash recovery, not a multi-file power-loss transaction.

The broker manages **official `@openai/codex@0.167.0`** by default; the server does **not** need Codex CLI preinstalled. See the installation details below. An explicit `codexCommand` overrides managed installation entirely for fixtures or deliberate operator use (an executable path/name, never a shell command). Existing configurations containing `"codexCommand":"codex"` still explicitly opt into PATH lookup; **remove that key** to use the managed pin. Each operation receives an isolated `HOME`/`CODEX_HOME`, not your normal Codex credentials. Public enrollment requests a provider device code, waits for the matching completion, reads the ChatGPT identity/credential and quota, then commits before activating. It never accepts credentials or administrator privileges from a public form. Protected manual `auth.json` import is a separate dashboard operation, also useful for reauthorizing quarantined accounts.

### Managed Codex installation

- **Prerequisites:** Node 24+ for the extension, trusted npm 10+ on PATH for an initial install/repair, and Linux or macOS on x64/arm64. Only Linux x64 is real-binary tested here; Windows and other targets fail explicitly. The broker does not install Node/npm. Verified cache reuse does not require npm or registry access. No global install, `npx`, floating version, auto-update or fallback to global Codex occurs.
- **Pin/integrity:** committed `codex/package.json` and npm v3 `codex/package-lock.json` pin the official wrapper and six platform artifacts to 0.167.0, with official HTTPS tarball URLs and SHA-512 integrity. Private `npm ci --ignore-scripts --include=optional` performs locked installation/integrity verification. The matching native binary is invoked directly (layout verified against the pinned official launcher); its `--version` must be exactly `codex-cli 0.167.0`.
- **Private storage:** `dataDir/codex/` contains `current/`, disposable `staging/`, npm `cache/` and an isolated installer `home/`. The private parent is 0700; no runtime artifact is written into the extension/repository or another Codex home. On Linux x64, the observed installed tree is ~438 MiB plus ~166 MiB cache; allow at least 1 GiB free for installation/repair. Credentials are confined to the existing private store and per-operation `runtimes/`, not used during installation.
- **Reuse/recovery:** installation is single-flight within the provider, under the existing exclusive data-directory store lock. A completed staging tree is atomically renamed only after version validation and a SHA-256 tree digest. On each worker startup, reuse checks the pin/lock identity, file contents/modes/symlink targets and binary version. Partial/corrupt installations are removed and rebuilt; npm also verifies cached downloads. The marker detects accidental corruption, not malicious changes by the same OS user. No shared/multi-process cache claim.
- **Network and lifecycle:** first startup/repair needs direct HTTPS/DNS access to `registry.npmjs.org`. npm user/global configuration and credentials are not inherited; custom registries/proxy configuration are not supported. Later provider login/refresh/quota calls independently need provider network access. Preparation starts in the background because ProxyKit setup has a 10-second deadline; listeners can be ready before Codex is ready. Provider operations await preparation. A refresh's existing 25-second deadline may expire during a cold install without quarantining its credential; background preparation continues. Installation is bounded to 180 seconds, npm-availability/CLI-version probes to 10 seconds, and diagnostics to 64 KiB. Cancellation of the last waiter or graceful shutdown terminates the installer process group (SIGTERM, then SIGKILL after 500 ms) and removes staging. Startup failures log a sanitized `CODEX_*` code; later operations can retry, never change the pin.
- **Upgrades/limits:** upgrade the pin by reviewing/updating the committed manifest/lock and `CODEX_VERSION`, regenerating the build and rerunning tests; replace the broker with a reviewed revision using the disable/drain/remove/install/enable sequence above. Stop the instance before manually clearing its `codex/` cache. After a hard crash, verify **all** directory-using processes, including npm children, have stopped before clearing the stale store lock; a completion marker is not a transactional/fsync durability promise. Regular tests and the demo use explicit fixtures and do not download Codex. System tests first exercise account-free default setup (which may start background managed preparation), then use explicit synthetic adapters. `npm run test:codex` is the separate real download/initialize probe, **not** provider-account verification.

### Configuration

Default config is `<api.dataDir>/config.json`; edit only while stopped, preserving 0600 permissions. An explicit `BROKER_CONFIG` takes precedence and must name an **existing**, absolute, owned private regular JSON file, never a symlink. It bypasses automatic initialization; its configured absolute `dataDir` is preserved with no silent migration/deletion. Missing host storage fails clearly rather than falling back to CWD.

Optional legacy/external workflow: from this checkout run `node scripts/init.mjs /absolute/new/private-broker`, then start ProxyKit with `BROKER_CONFIG=/absolute/new/private-broker/config.json` in its server environment. The shared initializer also accepts an already-created empty private directory, but refuses **any** existing contents, unsafe ownership/permissions or symlinks; it never prints secrets. Existing explicit configurations do not need an initializer. Generated configuration contains:

| Key | Default / meaning |
|---|---|
| `dataDir` | Generated as `<api.dataDir>/data`; absolute private **dedicated** state directory; explicit existing overrides remain supported, single writer only |
| `adminHash` | Required SHA-256 hex digest of a high-entropy administrator secret |
| `dashboard` | `{ "host": "127.0.0.1", "port": 8788 }` |
| `enrollment` | `{ "host": "127.0.0.1", "port": 8789 }`; distinct port and origin |
| `enrollmentLabels` | `["Personal usage"]`; assigned by operator, never public visitor |
| `upstream` | `https://chatgpt.com/backend-api/codex`; fixed trusted origin/base path |
| `codexCommand` | Omitted: broker-managed **0.167.0**; explicit executable path/name bypasses installation and version checks |
| `pollMs` | `90000`; one sequential account refresh per tick; `0` disables ordinary polling, **not enabled automatic pulses or ambiguity confirmation**; otherwise 45,000–86,400,000 |
| `safeFallback` | `false`; opt-in narrow managed safe-method fallback, described below |

The data adapter supports `/v1/responses` and `/v1/models` (also unprefixed equivalents); it does not translate arbitrary OpenAI-compatible APIs. It replaces caller credentials with the selected account's bearer and `Chatgpt-Account-Id`. An optional `X-Broker-Preferred-Account` uses an internal account ID from authenticated `/api/status`, only after scope/reset ordering. Provider behavior at these paths remains live-unverified.

For external access, terminate TLS at a trusted reverse proxy. Configure each listener's exact `origin`, e.g. `"origin":"https://enroll.example.invalid"`, and preserve that Host and browser Origin. Non-loopback binds require an HTTPS origin; **the application itself does not serve TLS**. Keep backend ports firewalled; do not trust arbitrary forwarded headers. HTTPS origins enable Secure cookies. Do not expose the administration site just because enrollment is public. Apply edge admission/rate limits to public enrollment; built-in finite/global limits prevent unbounded work, not denial of service.

### Pulses, scheduling and usage

**Automatic inference is OFF by default.** Enable it explicitly in the authenticated dashboard's pulse settings (CSRF/origin protected), choose short and/or weekly windows, and set global scheduler spacing in seconds (default **60**, range **15–86,400**). Settings live in private durable state, not `config.json`. Enabling schedules one initial pulse for each enabled, verified account, then pulses after selected provider-reported resets. New eligible accounts are included. This consumes provider quota; admission/availability can prevent a pulse. It is not a guarantee that every account can pulse at every reset.

- **Real adapter, live-unverified:** each pulse uses the selected account's isolated `codex app-server` runtime, refreshes identity/quota, chooses an advertised text model (mini preferred; minimal/low reasoning where offered), then `thread/start` (ephemeral, no approvals, read-only) → `turn/start` with **“Reply OK.”** It matches thread/turn completion, ignores transcript/deltas, rereads quota and durably checkpoints changed credentials before routing. It does not call the broker selector or guess an OAuth/HTTP inference protocol. Manual Pulse is an authenticated POST, separate from Refresh quota.
- **Provider timing, not a five-day timer:** the short window is normally **five hours**; the weekly window normally seven days. Observed duration and reset timestamps drive display/scheduling, with a **45-second reset grace** and a fresh, complete two-window read showing advanced future resets before a due pulse. Either exhausted window or an uncleared quota block prevents inference. Elapsed time and successful inference never clear exhaustion; only confirmed observations can do that. Short/weekly resets due together coalesce into one operation. Window settings affect automatic triggers, not safety checks of both windows.
- **Bounded work:** a 15-second scheduler tick selects at most one account operation and enforces durable global spacing; regular refreshes share that lane. Per-account pulse/refresh operations cannot overlap. Provider subprocess admission remains four total (public logins leave a slot). Pulses have a 90-second total deadline; refreshes 25 seconds. Manual pulses have a five-minute minimum per-account interval. Failed/unconfirmed preflight work backs off 5, 10, 20, then up to 60 minutes. Ordinary successful quota reads may bring a due confirmation forward, but not bypass the five-minute pulse floor.
- **Crash/timeout safety:** reset targets, handled resets, outcomes, backoff and global spacing are durable. The dispatch boundary is committed before sending inference. Ambiguous dispatched attempts require a fresh quota read after grace and are **not automatically replayed for the same reset**; a later reset or deliberate manual pulse can proceed after confirmation. An interrupted credential operation remains quarantined until protected reimport; restart does not recover possibly rotated credentials from an abandoned home. Disable stops new automatic work and cancels in-flight automatic operations; already dispatched inference cannot be undone. Safely read rotations are checkpointed without re-enabling an account or overriding concurrent credential replacement/auth rejection.
- **Dashboard GET is read-only:** it shows the latest stored quota percentage, provider duration/reset, observation timestamp, fresh/stale/unknown status, last pulse and earliest next pulse/check (not a promised dispatch time). No GET sends inference, refreshes credentials or starts provider work. Observations older than five minutes or followed by failed/incomplete reads are marked stale; unknown is not zero. Refresh quota explicitly or enable ordinary polling. Counters are persisted per-account broker selections/upstream statuses/errors since this feature; they exclude pulses and are **not tokens, costs or historical totals**.

This is a reset-driven subset, **not** Codex Broker's full HELD/RELEASING/IN_CYCLE cadence, rolling-window/two-read cycle reconciliation, first-four usage lane, daily sweep or persistent event outbox. Provider completion failures are recorded, not automatically retried for the same reset; unknown model catalogs fail closed. Existing stream/fallback/security limitations below still apply.

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
