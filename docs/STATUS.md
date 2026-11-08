# Capability and verification status

Updated 2026-11-08. This is a first single-instance implementation, not full Codex Broker production parity.

## Evidence

- Starting ProxyKit source: `d0309d10f9474e0b6f9167ee00fa532a72174421`. SDK types, runtime, CLI installer, worker, native example and current status/architecture documents were inspected before implementation. **Required host correction:** `ade6cc994ca301ac3a2b06d7108a42f6919a1efc` in `/code/proxykit`, separately committed locally, not pushed. It adds read-only ingress trailer presence; older hosts receive `HOST_UPGRADE_REQUIRED` from authenticated broker requests. Build this corrected host for the demo/system tests.
- Codex Broker source: `42a931e15daaaa1540958ebdc283c2a48acfcb8b`. Selection/refresh/login/quota and public-site behavior were traced from source, not guessed from the example.
- `npm test`: **50 tests passed** (managed-install follow-up), covering policy, store, subprocess, hook contracts and actual HTTP listeners. Deterministic clocks/fixtures test selection and reset confirmation; private disposable files test durable writes and failures. Tests use synthetic credentials only.
- `npm run test:codex`: **1 real isolated CLI test passed** on Linux x64, Node 24.16.0/npm 11.13.0: official locked install, exact `codex-cli 0.167.0`, verified reuse without npm, generated account-protocol schemas, and `app-server` initialize/initialized with a private empty home. No login, account RPC, inference or production data. Cold install plus probe took ~22 seconds.
- `npm run test:system`: **1 installed-system test passed** at pushed Broker Proxy runtime revision `569c858986aed2af6987ed6435ba4937e5600979`, using a freshly compiled, unchanged ProxyKit `ff77102` (includes local correction `ade6cc9`). Real CLI GitHub installation, compiled Go proxy, installed Node worker and local upstream; includes trailer rejection, GET/HEAD/OPTIONS fallback and POST/implicit-body no-retry cases. The installed dedicated Codex lock matches the repository; the explicit fixture override creates no managed Codex directory. Documentation-only commits after this runtime revision do not change its behavior.
- Host correction: all **11 Go packages** passed normal and race tests; focused trailer tests passed ten race-enabled repetitions; vet/build and **3 SDK tests** passed (including readonly TypeScript checking, zero skips). Tests cover original Bind snapshots, child/reentry independence, non-spoofability and installed Node serialization of both boolean values.
- Guided demo smoke passed with actual CLI install, dashboard login/action, fixture device enrollment, proxy forwarding, clean stop and durable restart. Private-instance initializer smoke passed without printing generated secrets.
- Earlier implementation's Pi subagents reviewed policy/store/provider and the application/security boundaries. Concrete findings were fixed with regression tests, not treated as verification by themselves.
- **No real-provider login, refresh, quota call, or inference verification.** No production deployment, migration or npm publication. Neither source inspection nor the protocol fixture establishes provider compatibility.

## Implemented, partial and deferred

| Area | Status | Evidence / boundary |
|---|---|---|
| TypeScript extension packaging | Implemented | Manifest v1, committed compiled ESM, actual SDK type checking, CLI install/activation |
| Proxy transport | Reused | Go ProxyKit owns upstream execution, streams, cancellation and managed children; no application inference server |
| Caller auth and label ACL | Implemented, application-owned | Persisted SHA-256 token digests; allow-any/block-wins; credentials removed from editable headers; owner metadata identifies caller |
| Native request trailers | Reject declared trailers | Read-only host ingress fact; older hosts fail closed with `HOST_UPGRADE_REQUIRED`; no mutable trailer API or late undeclared-trailer detection |
| Host trusted authentication | **Missing bridge capability** | Installed Node cannot set host `input.auth`; managed children explicitly reauthenticate, not fabricated trusted identity |
| Durable accounts/callers | Implemented, single writer | Atomic private JSON, fsync, serialized writes, lock, 32 MiB commit/reopen limit, bounded history; fail closed on persistence ambiguity |
| Crash recovery | Partial/operator-assisted | Graceful restart automatic; stale crash lock requires verified operator removal; interrupted refresh quarantined |
| Account activation/actions | Implemented | Protected import, enable/disable, label edit, refresh, caller creation and enable/disable; reimport preserves deactivation/quota blocks |
| Selection and quota | Implemented cycle-disabled subset | Exact reset-first ordering, scope, exhaustion, monotonic complete snapshots and block grace; see parity below |
| Credential refresh | Implemented adapter, fixture-tested | Single flight per account, expiry threshold, identity check, persist rotated credentials before reuse; ambiguous failures require reauthorization |
| Managed Codex CLI | Implemented, real Linux x64 install tested | Exact official `@openai/codex@0.167.0`; npm lock/SHA-512 integrity, private install/cache, tree-digest reuse, atomic staging, bounded cancellable subprocess group; explicit command override bypasses installation |
| Provider login | Implemented adapter, **live-unverified** | Isolated `codex app-server` device login and matching completion; no broker-invented direct OAuth protocol |
| Provider quota | Implemented adapter, **live-unverified** | `account/rateLimits/read`; codex bucket preference; missing/ambiguous data stays unknown or preserves prior observation |
| Public enrollment | Implemented, fixture-tested | Separate listener, session-owned start/status/cancel, CSRF/origin checks, bounded device flow, expiry, duplicates and durable activation |
| Minimal dashboard | Implemented | Authenticated forms, account/caller actions, quota timestamps, basic upstream counters, recent selections; no credential display |
| Polling | Simplified | One sequential account refresh per configurable tick; no exact production four-member/daily/reset scheduler |
| Streaming | Opaque forwarding tested | Exact split SSE bytes and client cancellation verified; no semantic event parsing or claimed token usage |
| Safe fallback / managed calls | Narrow opt-in subset | One response-start child exchange for explicitly bodyless safe methods after 5xx; normal request hooks, lineage and caller reauthentication |
| Unsafe inference retry | Deliberately absent | No POST retry, transport-error failover or replay after response commitment |
| Usage/accounting | Partial | Selections, observed upstream statuses/errors and history only; no token/cost/cache accounting, transport/delivery error totals or answer decoration |
| Cycle/relay/worker orchestration | Deferred | No HELD/RELEASING/IN_CYCLE pulses, relay reservations, worker leasing or cycle cadence |
| Multi-instance, vault, WebSocket | Not claimed | Single private state directory; no encryption-at-rest service or WebSocket compatibility |

## Source-policy parity and deliberate deviations

All paths here refer to the pinned Codex Broker checkout under `/root/code/codex-broker`.

| Reference rule | New implementation | Difference / test |
|---|---|---|
| `internal/broker/router.go:147`, `internal/auth/scopes.go:13` eligibility and scope | `src/policy.mts` candidates/inScope | Active + verified credential, enabled caller; no runtime worker/deleted state in this smaller model; blocks beat allows |
| `router.go:201`, `domain_test.go:59` ranking | Future weekly reset → future short reset → preference → createdAt → ID | Missing/past reset last; unknown usage eligible; remaining percentage and last-route time are not a score |
| `router.go:170` exhaustion | Either quota percentage 100 or global block | Elapsed reset/block timestamps never clear exhaustion |
| `credentials.go:415`, `quota_test.go:143` quota confirmation | Complete valid two-window observation, monotonic start/observation ordering | Block clears only on read started >=45 seconds after rejection; stale/in-flight/incomplete data cannot unlock |
| `router.go:291` scoped exclusions | 5xx creates caller/account exclusion; pure helper supports rate-limit duration | No account roulette on lease failure. HTTP 429 cannot distinguish quota from rate limit without protocol parsing, so conservatively blocks globally |
| `router.go:31` authentication failure | 401/403 quarantines the matching credential generation | **No forced same-account auth retry**, because transparent replay of POST is unsafe; protected reimport needed to restore auth |
| `router.go:105,255` retry computation | Latest exhausted window reset; earliest pool reset/exclusion/45-second confirmation candidate | No configured padding or HTTP Retry-After emission; error distinguishes awaiting confirmation versus unknown |
| `credentials.go:88,151` refresh/checkpoint | Serialized refresh and durable checkpoint, isolated runtime | Adapter requests `account/read` with `refreshToken:true` for refresh (reference calls `Account(false)` even on forced path); live semantics unverified |
| `usage.go:10` quota normalization | Prefer `rateLimitsByLimitId.codex`; weekly 10,080 minutes ±5%; unique shortest <1 day | Complete percentage baseline only; failure/incomplete result preserves old exhaustion |
| `usage_poll.go`, `reset_poll.go` polling | Configurable sequential round robin over enabled verified accounts, including exhausted | No persistent event outbox, reset-triggered coalescing, first-four policy, daily sweep or five-minute event retry; 45-second block grace remains enforced |
| `cycle.go`, relay code | Not ported | No production cycle parity claim; ordinary eligible accounts only |

Per-account refresh uses a dedicated subprocess operation; maximum four provider operations, with public device logins leaving a refresh slot. Other refreshes can still receive transient `PROVIDER_BUSY`. Public enrollment is globally admission-limited, not a substitute for edge anti-abuse controls.

## Managed CLI and verified contract

The server needs **Node >=24 and npm >=10**, not a preinstalled/global Codex CLI. Default installation is under `dataDir/codex`, owned by the extension and the existing exclusive store lock. The committed npm v3 lock contains exact official registry tarballs and SHA-512 integrity for the wrapper and platform artifacts. `npm ci --ignore-scripts --include=optional` verifies downloads, including npm cache reuse. A completed install is published by atomic staging rename after exact version verification; a private SHA-256 tree marker detects accidental file/mode/symlink corruption at subsequent startup. This is not protection against another malicious same-UID process, nor an fsync durability or multi-process cache claim.

Managed targets are Linux/macOS x64/arm64; only Linux x64 was executed. Unsupported targets, missing/old npm, network/install errors and wrong binary versions fail without fallback. Cached verified reuse works without npm/network. Initial installation/repair needs direct access to `registry.npmjs.org`; npm user/global config and secrets are not inherited. Node/npm provisioning and custom registry/proxy support are out of scope. Observed Linux x64 disk use: ~438 MiB installed + ~166 MiB download cache; allow >=1 GiB free. Explicit `codexCommand` still bypasses installation/version checking (including an existing literal `codex` value); omit it to select managed mode.

Actual host inspection found a 10-second worker startup deadline. Setup therefore registers listeners/hooks/cleanup and starts background preparation rather than awaiting downloads. Operations wait for that same preparation. Installation has a 180-second total deadline, 10-second npm/version probes, 64-KiB diagnostic cap, and process-group SIGTERM → SIGKILL after 500 ms on cancellation/close. Last-waiter cancellation cancels installation; one cancelled waiter cannot cancel other waiters. Provider close waits for installation cleanup. Interrupted staging is discarded on retry/startup under the store lock. Hard crashes still require operator verification that all directory-using processes have stopped before clearing a stale lock.

Refresh preparation occurs **before** persisting `authState:refreshing`, so pending installation cannot turn into a quarantined interrupted refresh on restart. Installation/admission failures are distinguished from potentially credential-rotating runtime errors; only the latter retain the existing conservative quarantine policy. The existing refresh timeout can expire during a cold install; the shared background preparation may continue. No usage pulses were added: quota refresh remains `account/rateLimits/read`, not an inference loop.

Official npm metadata and the shipped launcher were inspected for 0.167.0 (metadata declares Apache-2.0; no binary vendored). The matching native `vendor/<target>/bin/codex` is launched directly to avoid an extra wrapper process. Real generated JSON schemas confirm `chatgptDeviceCode`, device response fields, `refreshToken`, quota response fields and initialization shape. The real subprocess accepted the adapter's initialize payload and reported the isolated Codex home/version. This validates installation and protocol shape, **not successful provider authentication, refresh, quota semantics or inference**. Reproduce with `npm run test:codex`; it uses a disposable directory, no provider accounts or credentials, and no global install.

## Provider contract and state boundaries

`src/provider.mts` launches `codex app-server`, performs `initialize`/`initialized`, starts `account/login/start` with `{type:"chatgptDeviceCode"}`, waits for `account/login/completed` with matching ID, reads `account/read` and `account/rateLimits/read`, stops the runtime, then validates `auth.json`. Cancellation sends `account/login/cancel` when possible, then terminates/reaps the process. Protocol and stderr details never become public errors. URL validation permits only HTTPS `auth.openai.com`; even the fixture returns that hostname but never contacts it.

The reference's actual implemented authorization is app-server RPC. Direct `/deviceauth/token`/`oauth/token` descriptions were documentary evidence only; no client ID or direct HTTP grant was guessed. Browser callback OAuth and manual public token login are not implemented.

Public state is `starting → waiting → verifying → completed`, with failed/cancelled/expired terminal branches. Session cookie ownership controls status/cancel; no public catalog or caller management. Activated provider identity is private, and public status omits credentials and email. A complete account is persisted before activation is visible. Cancellation wins before the queued activation transaction starts; after that commit boundary it may finish as completed. Browser sessions expire and do not survive process restart.

## Trusted-host gap and concrete follow-up proposal

The installed SDK's `input.auth` is read-only; there is no authentication registration method for Node extensions. `request` can replace editable headers and write owner metadata, but the pre-hook `requested` snapshot still contains original caller Authorization. This implementation uses verified bearer digests and **internal owner metadata**, never ordinary identity headers, for its own policy. Managed fallback explicitly presents the original bearer to the normal request path again. It makes no claim that other extensions receive authenticated host scope.

For a reusable host identity boundary, propose a separately reviewed host authentication admission API that (1) consumes caller credentials before snapshots are published to unrelated hooks, (2) sets immutable trusted subject/claims, (3) explicitly governs child inheritance and revocation, and (4) includes cross-extension credential-absence and child-scope tests. This is larger than a broker patch and is **not implemented here**. A generic host need not mandate destination policing; the broker still owns its fixed upstream/credential policy.

Ordinary installed extensions share trusted process/OS authority. This application's dashboards, public responses, own counters/history and own logs exclude provider/caller secrets. This is **not** a promise that arbitrary trusted extensions, host raw snapshots, debug tooling, or a malicious upstream cannot see data entrusted to them. Request/attempt IDs are used for history, never guessed conversation identities.

## Focused regression evidence

- Concurrent refresh shares one provider call; independently cancelled waiter does not cancel another; policy is rechecked after refresh.
- Disabled account/revoked caller cannot be resurrected by refresh; stale label form cannot toggle activation. Delayed 401/403 for an old credential generation cannot quarantine a newer refreshed/imported credential.
- Older quota completion cannot replace newer exhaustion; elapsed reset and partial read cannot unlock.
- Persistence failure prevents publication and poisons routing; restart quarantines interrupted refresh. Oversized commits are rejected before disk replacement without poisoning the last reopenable state.
- Malformed/denied/mismatched/unsafe-URL/expired/cancelled device flows terminate and clean up; shutdown awaits setup as well as child cleanup.
- Public login saturation leaves refresh capacity; provider admission failure is retryable, not permanent quarantine.
- Managed-install fixtures verify exact official lock/pin, eight concurrent waiters sharing one install, verified reuse with npm absent, content/mode/marker/partial-install recovery, failed/noisy/wrong-version/missing-platform/old-or-missing npm, retry, individual cancellation, total deadline and shutdown/reaping of an uncooperative process group. Provider shutdown also covers background preparation and waiting refresh without persisting quarantine. Explicit fixture commands bypass installation, including in the GitHub-installed system test.
- Queued activation honours cancellation; cancellation after completed commit does not delete the account.
- Actual HTTP tests enforce admin authentication, CSRF/origin, public ownership, separate APIs, duplicate enrollment and second-listener startup rollback. Bursts of anonymous visits reclaim unused anonymous sessions rather than locking new users out for an hour; authenticated/enrollment-owner sessions are retained.
- Installed-host system test verifies missing-bearer rejection, exact upstream credential replacement, cookie/API-key stripping, caller scope, split SSE, cancellation propagation, managed fallback, account disable, process cleanup, and persisted restart state.

## Reproducibility and remaining verification

Run the commands in the README. Tests bind loopback, use disposable directories and synthetic credentials. The GitHub system test requires a pushed commit; override its reference deliberately rather than claiming unpublished local edits were installed. The exact installed Codex version and unauthenticated initialization/schema checks are now verified separately. A live-provider acceptance pass still needs an operator-authorized account, provider authorization, refresh/quota/inference evidence and safe handling of secrets. No such account was requested or harvested from existing installations.
