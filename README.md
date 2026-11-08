# Broker Proxy

A TypeScript account-brokering extension for [ProxyKit](https://github.com/NotRllyRn/proxykit), intended to become the successor to [Codex Broker](https://github.com/NotRllyRn/codex-broker).

**Status: repository bootstrap; the TypeScript implementation has not been built yet.**

Planned features:

- Extension-owned account enrollment, credentials, refresh, quota-aware selection and rotation.
- A minimal administration dashboard on its own port.
- A separate, minimal public enrollment service on another port.
- Integration with ProxyKit's existing extension lifecycle, HTTP hooks and observability.

Read [IMPLEMENTATION_PROMPT.md](IMPLEMENTATION_PROMPT.md) for the implementation brief. The [reference directory](reference/README.md) contains the original Go example as porting material, not a runnable TypeScript extension.

No accounts, credentials or private data belong in this repository. Licensing has not yet been selected; preserve source attribution and review licensing before redistributing third-party code.
