# Trusted broker application proof

An independent Go library/example, **not a second HTTP proxy or a mandatory host account service**. Run its executable proof with:

```sh
go test ./examples/brokerapp
go test -race ./examples/brokerapp
go vet ./examples/brokerapp
```

The tests use local HTTP upstreams, loopback listeners, generic labels and synthetic credentials only. There are no external services or dependencies.

## Small integration surface

1. `OpenStore(privateDirectory)` loads extension-owned committed accounts and pending notifications. Exactly **one process / Store instance** may own that directory, including during recovery. Existing directory permissions are the operator's responsibility. Files are private (`0600`), but credentials are plaintext, not encrypted.
2. `Store.Activate(Account)` atomically commits account state, labels/ACLs and an outbox notification. Trusted service-authenticated `POST /enroll` uses exactly this operation, including activation and deactivation. It is not OAuth or an account-verification flow.
3. `New(store, Config)` copies caller-token identity mappings and exact allowed endpoints. `Refresh` and `Notify` are trusted cancellation-aware callbacks. Refreshed credentials are persisted with a revision check, without overwriting concurrent enrollment changes.
4. `Broker.Execute(request, requestedModel, maxAttempts, Dispatcher)` authenticates the original request; selects by stable account-ID order; binds a fresh request-local account/provider/model/endpoint/credential; and returns sanitized per-attempt outcomes. Fallback uses only previously untried accounts and **rechecks committed ACLs and destination policy**. Requested model is provenance, not authority; configured served models may differ. Selection policy is intentionally simple, not quota optimization. A dispatch error, invalid status or 5xx permits another attempt within the explicit limit; no client delivery occurs here. Streaming, replayable request bodies, response commitment and retry safety remain host bridge responsibilities.
5. `Start(broker, catalogListener, enrollmentListener, serviceToken, retryInterval)` takes ownership of two separate listeners and starts a notification retry job. `GET /catalog` requires caller authentication and shows only eligible labels/routes/quota. `/enroll` requires a distinct service credential; caller credentials cannot enroll, and the service credential cannot impersonate a caller. Enrollment accepts bounded JSON and rejects unknown fields/trailing values. No caller-supplied identity header or body field is trusted.
6. `Application.Close(ctx)` **or** `Broker.Close(ctx)` stops admission, cancels requests/refresh/jobs, closes owned listener connections, and waits for owned work. Only one Application may start per Broker. Retry after a close timeout is supported; cancellation cannot forcibly terminate trusted callbacks. Caller-owned dependencies, such as a dispatcher's HTTP transport, remain the caller's cleanup responsibility.

`Dispatcher` is deliberately a minimal **trusted managed-dispatch bridge**, not an ordinary observer. It alone receives the credential-bearing `Attempt`. A real bridge must use host-managed execution/observations; build fresh authentication for the exact selected destination; not clone inbound auth/identity headers; disable redirects or reauthorize each hop; and propagate context cancellation. `TestIdentityAccountIsolationAndLocalUpstreams` demonstrates a local `net/http` bridge with fresh requests and redirects disabled. The library cannot police arbitrary sockets opened by trusted Go code.

`Outcome` contains attributed caller/account/requested/served model, status and optional provider usage. It has no credential, raw callback error, request body, inbound headers or URL. Callback errors become fixed sentinel errors. The library does not log. Callbacks must not log or retain secrets. `QuotaSnapshot` has its own observation timestamp and remaining counter; it is never converted into `Usage`. Unknown provider usage is `nil`, not zero. Quotas are in memory in this proof and updated through a trusted application method, not an implemented provider polling service.

## Opt-in real host adapter

`NewHost(broker, HostConfig)` composes `proxy.NewWithEngine` with native registrations; it does **not** use `Execute` or implement a second dispatcher. Supply two loopback listeners, a distinct enrollment service token and a positive notification retry interval. The native setup hook calls `Start`; engine cleanup closes the Broker/application. Do not also call `Start` on that Broker. Listener ownership transfers even if construction fails. Caller code owns the external gateway server and must stop it; `Host.Close(ctx)` shuts down the engine/application and closes the adapter-owned transport's idle connections.

For example, after creating a private Store and configured Broker as above:

```go
catalog, err := net.Listen("tcp", "127.0.0.1:0")
if err != nil { return err }
enrollment, err := net.Listen("tcp", "127.0.0.1:0")
if err != nil { catalog.Close(); return err }
host, err := brokerapp.NewHost(b, brokerapp.HostConfig{
    Catalog: catalog, Enrollment: enrollment,
    ServiceToken: serviceToken, // independently provisioned; never a caller token
    RetryInterval: time.Second,
    Execution: extension.Config{BodyBytes: 1 << 20, Attempts: 4, Depth: 3},
    Registrations: independentObservers,
})
if err != nil { return err }
// Install host as the Handler of an independently owned http.Server.
// Stop that server, then call host.Close(shutdownContext), including on errors.
```

The ingress adapter strips bearer/cookie and identity-shaped headers **before** `Engine.Bind` captures original request facts, then authenticates the original bearer or accepts a host-verified inherited subject. Public lineage/capability spoofing is rejected, not treated as an identity. `host.Engine.Client` is available to trusted active hooks for scoped ordinary-HTTP reentry; it pins the gateway origin and refuses redirects. No public URL, header, requested model or account ID grants account access.

`broker.retain` saves bounded input **before** supplied request transforms. `broker.route` runs after all supplied request hooks, rechecks ACL/destination/expiry and binds fresh credentials to the entire exact configured endpoint. It ignores public path/query routing, and does not rewrite protocol model fields merely because an account has a served-model label. Account metadata is private to owner `broker`; independent observers use host exchange/root identities and original source observations. Supplied hooks must cooperate with these orderings (contradictions reject activation). Reserved `broker.*` IDs cannot be reused.

On an effective 5xx, `broker.fallback` may request a managed full-chain child before commitment, replaying the saved input rather than double-applying request transforms. Both original and effective methods must be GET/HEAD/OPTIONS; POST is never automatically retried. Parent and direct descendants use distinct eligible accounts. Ordinary HTTP reentry gets fresh selection state while retaining the engine's shared root budgets and verified auth. Fallback/child selection rereads committed policy and refreshes credentials. Exhausted accounts/budgets or failed child processing preserve the original parent candidate. A single handler slot rejects recursive HTTP work immediately rather than deadlocking. The underlying RoundTripper does not follow provider redirects; a returned 3xx remains a client-visible response.

Limits are deliberate: all ingress request bodies are Whole-retained under the engine bound, so this is not a streaming-upload example; declared request trailers are rejected. Bounded child responses may also be retained. Memory is per exchange/root, not a global admission bound; disabling body/attempt limits loses bounded retention. Transport errors have no ResponseStart fallback seam and return the proxy's normal 502. Unread abandoned parent bytes (including usage present only in those bytes) are **unknown**, not zero; no provider usage parser or durable host accounting sink is supplied. `OriginalBody` observes only consumed original upstream bytes before decoration. `Finish` is reader completion; only `Delivery` reports final writer status/bytes, not peer receipt. Response decorators run for both a child and its parent; non-idempotent decorators must account for that explicitly. Cancellation/shutdown can suppress cooperative terminal callbacks; per-request state is context-owned rather than relying on Finish for cleanup. See the host socket tests and requirement mapping for exact evidence.

## Durability and notification semantics

Each transaction writes a private staging file, fsyncs it, atomically renames it over `broker.json`, then fsyncs the directory. The in-memory snapshot is published **only after success**. A persistence failure poisons the current Store: routing, catalog and notification delivery fail closed until recovery. In particular, an error after rename but before successful directory fsync is an **uncertain commit**, not a guaranteed rollback: recovery may find the complete new transaction. Do not retry uncertain activation as though it definitely did not happen.

Restart loads either complete committed state; interrupted staging files are ignored (not automatically garbage-collected). The file/directory must reside on storage with the tested atomic-rename/fsync semantics; no Windows/network-filesystem or power-loss certification is claimed. There is no multi-process lock, distributed lease, multi-replica consistency, migration or corruption repair.

Activation and notification creation are one transaction. Notification delivery and durable acknowledgement are necessarily separate: a crash or ack failure can cause duplicates. `Notification.ID` is stable and monotonic within one store, not globally across independent stores. Receivers must deduplicate by store identity + notification ID. The subprocess crash test records receiver receipt, exits before ack, reopens the store, verifies the same ID is retried, and demonstrates receiver deduplication. Pending entries remain on callback failure/cancellation and retry at the configured interval. No exactly-once delivery claim is made.

There is no OAuth, real account integration, dashboard, process sandbox, production secret store, notification queue bound, or production multi-replica store. Protect remote listeners with TLS and service credential provisioning; the shipped tests exercise loopback HTTP only. See `docs/implementation/brokerapp.md` for requirement evidence and remaining host limitations.
