# Broker Proxy implementation plan

Written before implementation, 2026-11-08. Execute this plan without another routine approval gate.

## Evidence and scope

- ProxyKit `/code/proxykit` is exactly `d0309d10f9474e0b6f9167ee00fa532a72174421`; Codex Broker `/root/code/codex-broker` is exactly `42a931e15daaaa1540958ebdc283c2a48acfcb8b`. No material revision differences at initial inspection. Codex Broker and production data remain untouched. Implementation later isolated one necessary ProxyKit correction: read-only native trailer visibility, documented in STATUS.md.
- Inspected SDK declarations/runtime, Node example, installer/worker/host contracts and source; implementation/status/research documentation and Go example are additional evidence, not APIs to invent. Read-only research covers the full required documentation/reference inventory.
- No source license grant was found in either reference. Implement behavior independently; use ProxyKit's public SDK declarations for compile-time checking rather than copying its implementation. Preserve the already-authorized reference copy. Do not invent a project license.
- Small, single-instance application; no second inference proxy, protocol conversion, production deployment, account migration, or npm publication.

## Architecture and actual hook mapping

Compile `.mts` TypeScript to dependency-free `.mjs` under committed `build/`; root manifest v1 points to `build/extension.mjs`. Use type-only imports checked against the actual ProxyKit SDK. Runtime uses the supplied setup API, not an invented host service. Configuration comes from an explicit private `BROKER_CONFIG` JSON file because CLI worker config only supplies `gatewayOrigin`.

- `request`, no body, required: validate bearer caller against persisted SHA-256 token digests, remove inbound credential/identity/cookie headers, attach caller/preference in the extension's owner metadata. Reject unauthorized requests locally. Do not claim Node can write `input.auth`: that field is read-only, and CLI has no authentication middleware.
- `resolve`, no body, requires authentication: select an eligible account, acquire/refesh its lease, record selection durably, replace full request URL using a fixed configured upstream origin/base path and separate `credentials` header arrays. Recheck caller/account policy after asynchronous refresh. Never infer identity from forwarded headers.
- `observe`, no body: use immutable original status plus owner metadata/identity to record account/caller failures, global quota blocks and scoped exclusions. No body parsing, token usage invention or credential logging.
- `finish`/`delivery`, observation only: bounded error/request counters using exact exchange/attempt identity. Leave SSE and all response bodies opaque. No response decoration.
- No automatic POST retry. Safe-method fallback is a separately tested bounded response-start child call only if the actual bridge preserves required ownership/auth constraints; otherwise document explicitly as unsupported. Managed `context.http` is host-supported but does not manufacture caller auth: independent test calls must authenticate normally. No unmanaged inference sockets.

## Durable store and policy

Single private directory (0700), atomic JSON replacement with fsync and 0600 files, serialized transactions, schema validation and a single-instance lock. Credentials remain private files, not encrypted-at-rest vault claims. Publish state in memory only after disk commit. Bound account/caller/history/session counts. Startup rejects corrupt state. Interrupted refresh stays quarantined until re-enrollment; pending public sessions expire on restart. Fail closed on ambiguous persistence failure. No multi-process writer claim.

Data: accounts (labels, enabled/auth state, private credential, created time, quota observations, global quota block), callers (digest, allow/block labels, enabled), caller/account exclusions, bounded selection history/counters, enrollment state. Private store API produces explicit credential-free public views.

Port cycle-disabled Codex Broker rules, not a new score:

| Rule | Source at pinned Codex Broker revision | Planned behavior |
|---|---|---|
| Eligibility and labels | `internal/broker/router.go:147`, `internal/auth/scopes.go:13` | Enabled + verified credential; any allow or unrestricted empty allow; block wins |
| Exhaustion | `router.go:170`, `quota_test.go` | Either percentage >=100 or global block; elapsed reset does not unlock |
| Ranking | `router.go:201`, `domain_test.go:59` | Future weekly reset, future short reset, preferred ID, created time, ID |
| Failure exclusions | `router.go:291` | Per caller/account: exhausted reset, else 60s rate-limit / 300s other |
| Quota rejection | `router.go:180`, `credentials.go:415` | Global block; only complete read begun >=45s after rejection clears |
| Refresh lease | `credentials.go:88,151` | Per-account single flight, refresh within 5min; persist before reuse |
| Retry | `router.go:105,255` | Latest exhausted reset per account, earliest pool candidate; 45s confirmation polling; unknown remains unknown |
| Usage normalization | `usage.go:10` | Prefer codex bucket; weekly ±5%, uniquely shortest short window; incomplete reads preserve baseline |
| Cycle/relay | `cycle.go`, `relay.go`, `usage_poll.go` | Deferred: window pulses, randomized HELD fallback, relay reservations, exact production polling cadence |

Affinity is only an explicit caller preference within scope and behind reset ordering, not guessed conversation identity. Record deviations including auth-failure retry (do not replay unsafe inference), runtime worker state and deployment-specific schedulers.

## Provider and enrollment

Narrow provider adapter launches configured Codex executable as `app-server` in fresh isolated HOME/CODEX_HOME/TMPDIR/workspace with an allowlisted environment. JSON-lines RPC: initialize/initialized, account/login/start `{type:chatgptDeviceCode}`, matching account/login/completed notification, account/read, account/rateLimits/read, account/login/cancel. Capture auth.json only after stopping the runtime. Never import the operator's normal Codex home. Bound processes, frames, RPC deadlines and total login lifetime; terminate/reap on cancellation. Provider error details are not public or logged.

Public flow: start -> waiting -> verifying/checkpointing -> completed; failed/cancelled/expired/restart-required are terminal. Session ownership uses random HttpOnly SameSite cookies; CSRF checks and independent admin auth protect mutation. Validate provider verification URL against HTTPS auth.openai.com (local fixture only via explicit configuration). Reject duplicate provider identity. Persist credentials before activation. New enrollment gets operator-configured labels, never public allow/block privileges. Protected admin/testing credential import remains visibly separate.

## Minimal web applications

Two extension-owned HTTP servers, independently configurable addresses/ports, loopback defaults dashboard 8788 and public enrollment 8789. Existing ProxyKit port 8080 remains data plane. Plain accessible server-rendered forms, no frontend framework. Dashboard uses admin session authentication, CSRF tokens, status/quota observation times, enabled/auth state, aggregate requests/errors, recent credential-free selections; actions import/enroll, enable/disable, refresh. Public service exposes only start/status/cancel for the browser's own enrollment; no account catalog/admin API. Bounded request bodies/sessions/timeouts, CSP/no-store/referrer protections, escaped HTML and generic errors. External binds require explicit public origins/TLS reverse proxy guidance; no deployment.

## Jobs and lifecycle

One configurable bounded sequential polling loop; no overlapping polls or unbounded job queues. Single-flight per-account refresh, cancellation-aware waiters, global process admission. Explicit cleanup closes both listeners, aborts provider work/timers, settles jobs, releases store lock. Roll back first listener on second-listener failure. Recovery removes only extension-owned temporary runtimes and marks interrupted operations safely.

## Milestones and acceptance

1. Plan commit, TypeScript package and actual installed-host smoke proof; caller/account isolation and real credential replacement.
2. Durable policy/state, deterministic clocks, ranking/scope/quota/reset/exclusion tests, concurrent refresh and write-failure tests.
3. Both real HTTP listeners, secure boundaries, fixture app-server device flow including denial/expiry/cancel/duplicate/restart and secret absence.
4. Actual ProxyKit installation/activation system test with local upstream, streaming bytes, cancellation, restart/shutdown, local early responses and managed-call behavior. Production CLI installer uses GitHub only; use production installer fixture and compiled CLI activation locally, then prove public CLI installation from pushed prebuilt repository if network access permits. Do not call a copied installation layout proof of CLI installation.
5. README, parity/status/provenance, local guided demo script with disposable fixture credentials, exact verification evidence. Small meaningful commits; publish repository commits only, not npm.

## Execution checkpoint

- Milestones 1–3 implemented: compiled extension, durable cycle-disabled policy, provider adapter and two minimal web sites. Provider flow remains fixture-tested, not live-verified.
- Real GitHub CLI installation and Node-worker system test passed; final revised-package rerun is recorded in STATUS.md. Safe fallback uses supported `child`, not an invalid no-body replacement.
- Review regression fixes cover quota ordering, process cleanup, refresh admission, queued cancellation, stale label edits, credential generations, bounded session admission and reopenable state-size limits.
- `finish`/`delivery` counters were not added: only selections and observed original upstream statuses/errors are currently measured. Transport/delivery errors and bytes/token accounting remain unknown.
- README, fixture demo and private-instance initializer added. Full cycle/relay scheduler, persistent event polling, host trusted-auth admission and live provider certification remain explicit limitations.

## Follow-up: broker-managed Codex CLI (planned before coding)

- Inspect official npm metadata/artifacts and pin an exact release (candidate `@openai/codex@0.167.0`, not a floating tag); commit a dedicated npm v3 lockfile including platform artifact integrity. Verify the actual binary version and unauthenticated app-server initialize contract in a disposable private home.
- Default to an extension-owned installation under the private data directory, never PATH/global Codex. Preserve explicit `codexCommand` for fixtures/operator-managed executables. Require Node >=24 and npm >=10 for managed installation; explicitly fail unsupported platforms/missing prerequisites, without fallback.
- Use `npm ci --ignore-scripts` with the committed lock and official registry URLs, private npm cache/home, bounded output/deadline, cancellation and process-group termination. Stage installs, validate version and installed-tree digest, then atomically publish a completion marker; discard partial/corrupt installs. Reuse only verified complete installs. Serialize in-process work; rely on the existing exclusive data-directory store lock for cross-process ownership, not a new multi-instance framework.
- Host-contract finding: ProxyKit worker startup is bounded to 10 seconds (`worker/worker.go`), so do not await network installation inside setup. Start a tracked background preparation after registering cleanup/listeners; every provider operation awaits the same preparation before spawning. Shutdown aborts/reaps installation and app-server work. Keep direct provider operations safe too. Distinguish pre-runtime/admission failures from possibly credential-rotating failures so installation errors cannot quarantine healthy accounts.
- Add fixture coverage for exact lock/pin, reuse, corruption/partial/failing install, single flight, cancellation/shutdown and override bypass. Demo/system fixtures must not install real Codex. Run full unit suite, a separate real isolated install/version/initialize probe without accounts, then push broker commits before the actual GitHub-installed system test. Leave `/code/proxykit` (local host fix `ade6cc9`) and production unchanged.
- Update README/STATUS with exact pin, prerequisites/network and disk needs, upgrade procedure and honest verification limits. No usage pulses or inference-loop changes.

### Follow-up execution checkpoint

- Exact official `@openai/codex@0.167.0` selected and verified; manifest/lock and compiled installer committed in runtime revision `569c858`. Default private installation, explicit override, background startup, cancellation/cleanup and pre-runtime refresh safety implemented. No host/production changes and no usage pulses.
- **50 fixture/regression tests**, **1 real isolated install/version/schema/initialize test** (Linux x64, no account), and **1 actual GitHub-installed system test** at pushed `569c858` passed. System fixtures bypass real installation and verify the shipped lock. See STATUS.md/README.md for prerequisites, private disk/network needs and remaining live-provider verification limits.

## Follow-up: account-specific pulses and reset scheduling (plan before coding)

- Preserve shipped `3e0ef46` and managed `@openai/codex@0.167.0`. No production accounts, runtime files, host edits, or agents. Inspected original `42a931e`: `internal/codex/adapter.go:PulseWindows`, broker operations/service, credentials pulse/preflight/checkpoint, cycle, reset/usage polling and their confirmation/scheduling tests. Original uses isolated app-server model/list → ephemeral thread/start → turn/start (`Reply OK.`), not broker selection or direct OAuth HTTP.
- Add a bounded account-specific pulse adapter using the actual pinned schema. Prefer visible text mini models and minimal/low supported effort; disable tools via read-only sandbox/never approval. Consume matching completion notifications without a transcript/notification queue. Read quota before and after; stop/reap runtime and checkpoint changed credentials before routing. Failures/cancellation retain a safe outcome, never expose provider diagnostics.
- Share per-account admission between refresh/pulse; durable generation-checked claim and completion, abort on disable/shutdown, recheck policy immediately before inference. Preparation/admission failures cannot quarantine healthy credentials. Ambiguous credential failures remain fail-closed. No late completion may restore concurrently changed auth/account state.
- Implement a deliberately smaller **reset-driven**, not HELD/IN_CYCLE, scheduler. Default automatic inference **off**; authenticated CSRF settings enable it and choose short/weekly windows and global spacing. Enabled scheduling seeds each eligible account after a fresh complete quota check, then watches provider-reported reset timestamps (normally five hours and seven days, never a guessed five-day interval). Coalesce due windows, wait original 45-second grace, confirm fresh available quota/advanced resets before pulsing. Persist pending reset targets, watermarks, next attempts and outcomes; preserve due resets across early reads. Sequential work, durable global pacing, bounded backoff and operation deadlines prevent bursts/restart storms. Unknown/exhausted/blocked accounts get observations, not inference. Ambiguous timeout/crash pulses require usage confirmation and are not automatically replayed for the same trigger; later provider resets may schedule new work.
- Keep existing single-writer storage and bounds with additive validated migrations. Store per-account observations/status/time, request/error counts, last pulse/outcome and next scheduled check. Dashboard GET only renders stored data with fresh/stale/unknown labels: no inference or refresh side effects. Separate Refresh quota and Pulse POST actions; simple settings/forms in existing UI, no redesign.
- Tests: deterministic reset/grace/coalescing/backoff/restart/disable/cancellation/generation cases; fixture model/thread/turn completion/error/malformed/truncated/late messages and credential checkpoints; real HTTP auth/CSRF/settings/stats. Extend installed-system fixture pulse coverage. Run npm test, pinned CLI unauthenticated schema/init probe, commit/push only broker-proxy origin main, then actual GitHub-installed system test. Update README/STATUS/demo with exact evidence and no live-provider claim.
- Explicit omissions: original weekly pool-size cadence, randomized HELD releases, rolling-idle two-read cycle classification, relay reservations, first-four/daily usage lanes and full event outbox are not ported. Reset confirmation and no-clock-unlock semantics are retained; pulse success alone is not reset evidence. Provider may reject pulses; outcomes must remain visible.

## Uncertainties to resolve honestly

- No live provider login/refresh/quota verification without operator-authorized private credential entry. Local app-server fixture is not real provider certification.
- Node cannot mutate host trusted auth or request another transport attempt directly. Keep application-owned authentication truthful; do not fabricate host scope or safe fallback guarantees.
- Installer has no local-path CLI option. Local tests must distinguish real installer API from real CLI; public GitHub installation requires pushed compiled artifacts.
- Full production cycle scheduling, webhook notifications, encrypted vault, multi-instance durability and semantic token usage are deferred, not completed features.
