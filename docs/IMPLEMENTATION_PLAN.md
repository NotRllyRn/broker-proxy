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
- Add a bounded account-specific pulse adapter using the actual pinned schema. Prefer visible text mini models and minimal/low supported effort; use read-only sandbox/never approval (not a guarantee of no tool calls). Consume matching completion notifications without a transcript/notification queue. Read quota before and after; stop/reap runtime and checkpoint changed credentials before routing. Failures/cancellation retain a safe outcome, never expose provider diagnostics.
- Share per-account admission between refresh/pulse; durable generation-checked claim and completion, abort on disable/shutdown, recheck policy immediately before inference. Preparation/admission failures cannot quarantine healthy credentials. Ambiguous credential failures remain fail-closed. No late completion may restore concurrently changed auth/account state.
- Implement a deliberately smaller **reset-driven**, not HELD/IN_CYCLE, scheduler. Default automatic inference **off**; authenticated CSRF settings enable it and choose short/weekly windows and global spacing. Enabled scheduling seeds each eligible account after a fresh complete quota check, then watches provider-reported reset timestamps (normally five hours and seven days, never a guessed five-day interval). Coalesce due windows, wait original 45-second grace, confirm fresh available quota/advanced resets before pulsing. Persist pending reset targets, watermarks, next attempts and outcomes; preserve due resets across early reads. Sequential work, durable global pacing, bounded backoff and operation deadlines prevent bursts/restart storms. Unknown/exhausted/blocked accounts get observations, not inference. Ambiguous timeout/crash pulses require usage confirmation and are not automatically replayed for the same trigger; later provider resets may schedule new work.
- Keep existing single-writer storage and bounds with additive validated migrations. Store per-account observations/status/time, request/error counts, last pulse/outcome and next scheduled check. Dashboard GET only renders stored data with fresh/stale/unknown labels: no inference or refresh side effects. Separate Refresh quota and Pulse POST actions; simple settings/forms in existing UI, no redesign.
- Tests: deterministic reset/grace/coalescing/backoff/restart/disable/cancellation/generation cases; fixture model/thread/turn completion/error/malformed/truncated/late messages and credential checkpoints; real HTTP auth/CSRF/settings/stats. Extend installed-system fixture pulse coverage. Run npm test, pinned CLI unauthenticated schema/init probe, commit/push only broker-proxy origin main, then actual GitHub-installed system test. Update README/STATUS/demo with exact evidence and no live-provider claim.
- Explicit omissions: original weekly pool-size cadence, randomized HELD releases, rolling-idle two-read cycle classification, relay reservations, first-four/daily usage lanes and full event outbox are not ported. Reset confirmation and no-clock-unlock semantics are retained; pulse success alone is not reset evidence. Provider may reject pulses; outcomes must remain visible.

### Pulse follow-up execution checkpoint

- Implemented `src/pulse.mts` and `src/scheduler.mts`, bounded provider notifications/credential salvage, shared generation-protected pulse/refresh lifecycle, validated additive state, authenticated settings/actions and stored-only dashboard stats. Managed Codex remains **0.167.0**; no host edits, agents, account access or production deployment.
- Deterministic/fixture/HTTP tests now cover reset/grace/coalescing, retries, durable pacing/recovery, cancellation, credential checkpoint/generation/caller races and pulse protocol failures. Real pinned CLI install/schema/initialize passed without login; account/model/thread/turn execution remains fixture-only, not live verified.
- Scheduling defaults **OFF**; enabled mode seeds accounts then uses confirmed short/weekly provider resets. The durable inference dispatch boundary consumes its trigger even on ambiguity; confirmation reads do not blindly replay inference. Original full cycle/rolling-idle/first-four/daily policies remain omitted as planned. README describes deadlines, spacing, backoff, quarantine recovery and the runnable fixture demo.
- Extended the real GitHub-installed system test to cover manual and automatic fixture pulses, settings, per-account stats and durable restart. Exact published-runtime/test evidence is recorded in STATUS after that network installation test.

## Companion migration: published ProxyKit hot activation (plan before edits)

- Verified remote `main` is `07a8cd010fc171a0d1cb9c5254ccbfee5714e536`, containing trailer fix `ade6cc9`, hot activation through `462c39b`, and CLI shutdown ownership fix `ae061aa`. Read the full authoring, hot-activation and verification guides. Shared `/code/proxykit` is clean at that pin; leave it untouched and build/test from a disposable pinned archive.
- Add required `apiVersion: 1` independently of `manifestVersion`. Explicitly enable the disabled installation before startup in the system harness/demo and operator instructions; explain online enable/`--activate`. No broker application or pulse rewrites.
- Pin source/SDK/binary documentation and the small real-Installer test dependency to that published revision. Install the broker candidate from its actual pushed GitHub commit; install only an unrelated response-header fixture through controlled archive transport. Reuse the compatibility probe's observable Linux PID/listener/lock checks, not its synthetic broker revision or patched archive.
- Assert live unrelated enable/disable toggles headers without changing broker PID, either listener socket, lock, authenticated admin session or account/pulse state. Check shutdown listener/process cleanup and both broker lock removal and host OS lock release. Retain trailer rejection and existing pulse/restart coverage.
- Preserve the pending pulse evidence after checking `/tmp/broker-pulse-system.log`. Run build/unit tests, the real pinned Codex schema/initialize probe (no account), repeated actual installed-system tests and demo smoke at the published candidate. Commit/push the minimal migration, then record exact evidence in a documentation commit; distinguish controlled fixtures from real GitHub downloads and live-provider verification.

### Companion migration execution checkpoint

- Published migration `407da0a` and test-harness correction `2173cf2`; application/build/Codex pulse files remain identical to `51a6c45`. Preserved preceding pulse verification after checking its system log. No delegates or shared-host checkout edits.
- Against published ProxyKit `07a8cd010fc171a0d1cb9c5254ccbfee5714e536`: 75 unit/HTTP tests, one real account-free Codex install/schema/initialize probe, three consecutive real GitHub-installed system runs at full candidate `2173cf250e57a8b980c4dcdab545008adaeb4f29`, and demo install/enable/pulse/enrollment/forwarding/restart smoke passed. Exact binary provenance and boundaries are in STATUS.md.
- Reusable Linux resource/session/state assertions and shutdown OS-lock acquisition now cover unrelated live enable/disable. Only the second extension is a controlled-archive fixture; the broker uses the actual GitHub CLI install. Provider account behavior remains synthetic, not certified live.

## Follow-up: persistent host storage (initial plan, superseded below)

- Verified published ProxyKit `main` and clean shared checkout at `f7859aa97ddb3c7597caf2c7efb72a16d901ccec` (storage feature `58140d69923480fa61929fdd608fcf104d6b4dcf`). Read EXTENSION_AUTHORING, SDK README, HOT_ACTIVATION and GETTING_STARTED in full. Review actual host directory validation, installed setup/IPC and CLI path discovery; build a clean pinned archive without modifying `/code/proxykit`. No delegates, production accounts or deployment.
- Minimal resolution: explicit `BROKER_CONFIG` wins; otherwise setup loads `<api.dataDir>/config.json`, never CWD. Preserve the config's explicit absolute `dataDir` (legacy external stores included). Init writes that field as `<host directory>/data`, keeping broker `lock`, `state.json`, managed `codex` and disposable `runtimes` below it, separate from config/secrets and host `.data`/`.owner-lock`. No automatic migration, repair, deletion or provider work before valid initialization.
- Accept an already-host-created directory only if empty, real (including no symlink ancestors), current-UID-owned and exactly 0700; retain exclusive 0600 config/secret creation and refuse all existing contents. Partial init remains visible and is not silently retried/deleted. New external directories remain supported. Keep startup validation and fail clearly on absent host support/uninitialized config.
- No copied SDK exists in this repository: build already type-checks directly against the actual host SDK. Use the pinned archive's updated declarations, update current compatibility/source links and the unrelated fixture's published Go module pin; preserve historical source attribution.
- Original manual discovery/provisioning workflow was cancelled before publication; the automatic setup amendment below replaces it. Keep explicit legacy override coverage and existing pulses/Codex lifecycle unchanged.
- Test default config resolution/precedence/failure and initializer existing-private/new/unsafe/symlink/no-overwrite/private-output cases. Extend real GitHub-installed system coverage for initialization without BROKER_CONFIG, uninitialized failure, persistence across restart/removal/reinstall and explicit external override. Retain unrelated activation PID/listener/locks/session/state and final cleanup checks; only unrelated fixture transport and providers are synthetic.
- Run build/unit tests, account-free pinned Codex probe, repeated installed-system runs and demo smoke. Publish small meaningful broker commits to origin main, pin the runtime candidate after push, then record exact revisions, reviewed source evidence and honest test boundaries in STATUS.

### UX amendment before resumed implementation

- User superseded the manual preparation workflow before publication. Verified published `main` at **`0559b73e2bb35961fc33577d72c39cd4ac7933ca`** and reread the four updated host guides in full. Installation now creates/validates storage under the host lock before package publication; the discovery CLI/control operation is removed. Preserve useful partial config/security/tests but remove reliance on that operation. Build from a new pinned archive, never modify the shared checkout.
- Default setup initializes application files itself through real `api.dataDir`: generated private admin/caller secrets, config and a `data/` state child. Share a small initializer with the optional external-directory script. Use an exclusive initialization marker, exclusive synced files and config written last. Retain the marker/partial files on failure and fail clearly on later setup; never guess that an interrupted initialization is safe, rotate existing secrets, overwrite data or auto-migrate. Document stopped-owner backup/restore or explicit archive-and-fresh-start recovery. This is not a general onboarding or migration framework.
- Existing default initialization is reused only after validating directory/file ownership, privacy and no symlinks, plus config/secrets/state presence; existing Store locking/schema checks remain authoritative. Explicit BROKER_CONFIG bypasses auto-init and keeps strict existing-file semantics and its configured absolute state directory. Missing host API never falls back to CWD. Init creates no provider runtime or inference; ordinary managed Codex preparation after setup remains unchanged, automatic inference remains OFF.
- Normal README flow: install --trust → enable → start; online --activate is supported. Explain secret retrieval from the known store's `.data/broker-proxy/secrets.json` on a private terminal, not via logs/HTTP. No manual directory creation/discovery/init step. Ports remain configurable with no automatic allocation.
- Verify actual installed automatic initialization on an empty install-created directory without env/manual preparation, private/stable secrets, restart/removal/reinstall/pulse persistence, unsafe/partial/no-clobber behavior, concurrent init exclusion, explicit legacy override, unchanged unrelated activation resources/session and final cleanup. Fixture-heavy system/demo runs may edit an already initialized disposable config to select synthetic providers/ports; label this separately from the actual default bootstrap test. Publish candidate before real GitHub tests; record exact evidence afterward.

## Uncertainties to resolve honestly

- No live provider login/refresh/quota verification without operator-authorized private credential entry. Local app-server fixture is not real provider certification.
- Node cannot mutate host trusted auth or request another transport attempt directly. Keep application-owned authentication truthful; do not fabricate host scope or safe fallback guarantees.
- Installer has no local-path CLI option. Local tests must distinguish real installer API from real CLI; public GitHub installation requires pushed compiled artifacts.
- Full production cycle scheduling, webhook notifications, encrypted vault, multi-instance durability and semantic token usage are deferred, not completed features.
