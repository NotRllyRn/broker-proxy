# Implement Broker Proxy: first standalone TypeScript broker extension for ProxyKit

## Assignment and authorization

Work in `/code/broker-proxy`, public repository `https://github.com/NotRllyRn/broker-proxy`. The user wants this project to become the official successor to Codex Broker, implemented as a real custom TypeScript extension/application on ProxyKit. This is the first standalone broker extension project, not the claim that ProxyKit has no other examples.

**First inspect the actual code and write a concrete implementation plan; then implement it.** Planning is a development step, not an instruction to stop and wait for routine approval. The user will monitor this new T3 thread directly. Do not report back to or monitor the originating thread. Do not create another thread for the work. Use software engineering techniques, YAGNI, minimalism, modularity and concise readable code. Prefer simple one-liners where they improve clarity, not compressed tricks or speculative frameworks.

The repository currently contains bootstrap documentation and a copied Go reference. Nothing here is a completed TypeScript implementation. Build, run and test the new application. Make small meaningful commits, update the README/status as features become real, and provide a reproducible local demo. Publishing this repository is authorized; production deployment, migration/deletion of real accounts and changing production Codex Broker are not part of the assignment.

## Read these sources before designing interfaces

ProxyKit checkout: `/code/proxykit`, bootstrap revision `d0309d10f9474e0b6f9167ee00fa532a72174421`. Inspect the current checkout and report any material revision differences.

- `AGENTS.md`, `README.md`, `docs/PROJECT_DIRECTION.md`.
- `sdk/README.md`, `sdk/index.d.mts`, `sdk/http.d.mts`, SDK implementation and tests.
- `docs/implementation/distribution.md`, `execution.md`, `system.md`, `brokerapp.md`, `ai.md` and `acceptance-audit.md`.
- `docs/REQUIREMENT_STATUS.md` for honest current support and gaps.
- `examples/node-personal-usage/`, `nodehost/`, `worker/`, `extensions/`, `extension/`, CLI install/activation code and tests.
- `examples/brokerapp/` (copied unchanged under `reference/proxykit-brokerapp/`). Translate the useful behavior and tests, not its Go packaging.
- `docs/EXTENSION_PLAN.md`, `EXTENSION_COMPOSITION.md`, `CORE_READINESS.md`, `EXTENSION_ENGINEERING_REFERENCE.md` and the current 50-row research checklist. These contain context/proposals; implemented SDK and verified status take precedence when determining what exists.

Codex Broker checkout: `/root/code/codex-broker`, reference revision `42a931e15daaaa1540958ebdc283c2a48acfcb8b`; upstream https://github.com/NotRllyRn/codex-broker. Read its repository guidance and relevant code, especially `internal/broker/router.go`, selection helpers/tests, `cycle.go`, `credentials.go`, `login.go`, `usage.go`, `usage_poll.go`, scopes/labels/exclusions and enrollment handlers/services/UI. Locate the actual routes and state machines rather than assuming file names imply complete behavior. Read the usage decorator/proxy code if implementing answer decoration. Never copy runtime credentials, databases, configuration secrets or private conversation files from that checkout.

## Product requirements

1. A genuine installable TypeScript extension using ProxyKit's current Node SDK/manifest/packaging contract. Compile TypeScript into the supported runtime artifact and prove installation/loading through the actual ProxyKit CLI. Do not replace the Go proxy or call a separate mock router and label it integration.
2. Extension-owned durable accounts, labels/access rules, caller authentication, upstream credential selection and refresh, usage/quota snapshots, account activation/deactivation and selection history. Reuse ProxyKit for transport and lifecycle. Credentials must never appear in dashboard responses, traces, logs or public files.
3. Account rotation and best-account selection **based on Codex Broker's actual method**. The Go example's stable account-ID ordering is intentionally simplistic and is not the requested final policy. Trace eligibility, caller scope, quota/exhaustion/reset, cooldown/exclusion, refresh, affinity/leases/cycle behavior and tie-breaking in Codex Broker. Write a small parity matrix with source references, port the relevant policy and test it with deterministic clocks/fixtures. Do not invent a new score and call it parity. Identify any intentionally deferred production-specific features.
4. A very minimal dashboard on its own configurable port: account labels/status, availability/quota with observation timestamps, active/disabled state, basic usage/errors and relevant actions (add/enroll, activate/deactivate, refresh when supported). Use simple accessible HTML/CSS/forms; no elaborate UI framework or visual redesign. Authenticated administration, clear errors and no credential display.
5. A separate minimal public enrollment service on a second configurable port, owned by this extension/application. It should provide a real basic browser flow modeled on Codex Broker's supported provider authorization, not merely relabel a service-authenticated JSON credential-import endpoint as public login. Public reachability does not mean unauthenticated administration. Identify the actual provider login/device/OAuth mechanism from source and implement the appropriate flow, states, cancellation/expiry and account activation. Keep manual credential import, if useful, an explicitly separate protected admin/testing operation. If a live provider prerequisite is missing, fully test the flow with a local fixture and clearly report what remains unverified.
6. The proxy data port remains ProxyKit's existing listener; the two new ports are dashboard and public enrollment, not replacement inference proxies. Separate public routes from admin functions. Both can default to loopback for local testing; document external bind/TLS/reverse-proxy requirements without deploying them.
7. Runnable local setup with durable state, clean shutdown of both listeners/jobs and restart recovery. Background refresh/polling should be bounded, configurable and cancellation-aware. Keep state storage appropriately simple for a single-instance first version; do not claim multi-process durability without implementing it.

## Preserve the user's extension philosophy

- Extensions can own complete applications/listeners/stores; host convenience services are not mandatory.
- No separate match/check callback: the handler decides and can return pass unchanged.
- Developers specify hook stages/dependencies; users should not have to manually solve ordering. Follow the actual current SDK, including any numeric order fields, without pretending a future API exists.
- Preserve original facts versus editable output; use owner metadata, request/attempt identity and the execution ledger. Broker request metadata must survive into its corresponding response without guessing conversation IDs.
- Early responses use the applicable response pipeline. Response-triggered model calls use the request pipeline and actual managed-call support, with lineage/cancellation/budgets. The current Node bridge may expose a managed helper rather than unrestricted internal capability headers: inspect and use the implemented contract.
- Credentials and destination policy are broker application responsibilities, not a demand for mandatory generic ProxyKit policing. This broker should nevertheless implement its advertised auth/ACL behavior correctly.
- Streaming chunks are not semantic SSE events. Do not add a prefix per chunk, corrupt tool calls, replay unsafe POSTs, or claim rollback after committed bytes. Port only safe documented fallback and distinguish real usage from quota snapshots and presentation. Retain unknown usage as unknown.
- Adjustable limits and trusted extension freedom do not justify hidden hangs, leaked secrets or false safety claims. No sandbox claim for ordinary trusted Node code.

## Important baseline limitations to improve honestly

The Go example has a durable file store/outbox, caller scopes, credential replacement and refresh callbacks, separate authenticated catalog/enrollment listeners, quota snapshots and a native ProxyKit host adapter. It has no dashboard, no real provider login/refresh/quota integration and no packaged TypeScript broker. Its host adapter has limited safe-method 5xx fallback, not general POST/chat or transport-error retry. Some features of the native Go adapter may not yet be exposed to installed Node extensions.

Before writing the application, verify whether Node can perform the necessary authentication, metadata/credential writes and lifecycle/listener operations. Record exact missing host capabilities if any. Do not silently fake authenticated identity through ordinary headers or bypass the host to claim support. Prefer existing public APIs. If a small ProxyKit bridge correction is necessary, describe and isolate it with focused tests; keep changes in that repository reviewable and separately committed, and do not modify production services. Larger host gaps should be surfaced to the user in this thread with a concrete proposal while continuing independent work.

## Plan and acceptance work

Write `docs/IMPLEMENTATION_PLAN.md` before coding, with architecture, actual hook mapping, selection parity, auth/enrollment flow, storage/lifecycle, minimal UI, tests and milestones. Track uncertainties and remaining requirements with accurate statuses. Then execute incrementally:

1. Working installed TypeScript extension and mock upstream, with caller/account isolation and actual upstream credential replacement verified.
2. Durable broker policy, selection/rotation and refresh coordination, including concurrent requests, quota/reset/cooldown and account changes.
3. Two extension-owned listeners and minimal dashboard/enrollment flow, with authorization boundaries, error/expiry/cancellation paths and no secret leakage.
4. End-to-end ProxyKit integration, shutdown/restart, streaming/cancellation, safe fallback and supported internal managed calls.
5. Document build/install/run commands, configurable ports, state location, implemented/partial/unverified features and a small guided local test the user can operate.

Use meaningful unit tests for selection/state rules, real HTTP integration tests for both web services and upstream forwarding, and an actual installed-worker/ProxyKit system test. Test unauthorized callers/enrollment/admin access, invalid inputs, concurrent refresh, persistence failures, cancellation and cleanup. Use mock providers first; they do not establish real provider login/compatibility. For a live credential, use T3 private secret entry rather than asking for secrets in chat. Do not harvest credentials from local production installations.

Use tiny dependencies only when justified; do not build a custom cryptographic protocol, broad plugin marketplace, generic job framework or multi-replica account system for this first iteration. Keep source provenance, review licenses before copying more code and do not invent a project license. Do not publish an npm package or deploy externally unless subsequently requested.

## Completion report in this new thread

Summarize working functionality, exact test evidence, local URLs/commands, source-policy parity and remaining limitations. Make it easy for the user to test the dashboard and enrollment flow. Do not claim that a fixture enrollment or account import is a verified real provider login. The user will continue here; no parent-thread monitoring or report-back is required.
