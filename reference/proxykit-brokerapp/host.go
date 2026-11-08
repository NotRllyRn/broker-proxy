package brokerapp

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/NotRllyRn/proxykit/extension"
	"github.com/NotRllyRn/proxykit/proxy"
)

// HostConfig transfers the two application listeners to NewHost, even on error.
// Registrations are trusted cooperating extensions, not isolated plugins. Their
// request hooks must precede broker.route (which binds the final destination).
type HostConfig struct {
	Execution           extension.Config
	Catalog, Enrollment net.Listener
	ServiceToken        string
	RetryInterval       time.Duration
	Registrations       []extension.Registration
	// Ingress wraps the proxy AFTER Bind, caller authentication and request-local
	// state installation. Trusted application middleware may add identity claims.
	Ingress func(http.Handler) http.Handler
	// Select opts into exact account selection. It must resolve trusted routes,
	// not caller identity headers. The selected endpoint must equal Request.URL;
	// protocol encoding therefore cannot silently target a different account.
	Select func(context.Context, extension.Input) (Selection, error)
}

// Selection contains no credential. Protocol is a trusted deployment assertion;
// the broker does not inspect or translate AI request bodies.
type Selection struct {
	AccountID, Protocol string
}

// Evidence is the actual authorized selection at the final request hook. It is
// request-local, not a lookup by endpoint (several accounts may share an origin).
type Evidence struct {
	AccountID, Provider, Model, Endpoint, Protocol string
}

// RouteEvidence is only available in the live request context after broker.route.
// It validates the observed effective request rather than echoing desired input.
func RouteEvidence(ctx context.Context, in extension.Input) (Evidence, error) {
	state, ok := ctx.Value(hostStateKey{}).(*hostState)
	if !ok {
		return Evidence{}, ErrDenied
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	e := state.attempts[in.Identity.Exchange].evidence
	if e.AccountID == "" || e.Protocol == "" || e.Endpoint != in.Request.URL {
		return Evidence{}, ErrDenied
	}
	return e, nil
}

// Host is an optional application adapter, not an alternative HTTP dispatcher.
// Engine.Client may be used by trusted hooks for scoped same-gateway reentry.
// The gateway server itself remains caller-owned; stop it before Close.
type Host struct {
	Engine    *extension.Engine
	handler   http.Handler
	transport interface{ CloseIdleConnections() }
}

type hostStateKey struct{}
type hostAttempt struct {
	excluded map[string]bool
	body     []byte
	method   string
	header   http.Header
	evidence Evidence
}
type hostState struct {
	mu       sync.Mutex
	attempts map[string]hostAttempt
}

func NewHost(b *Broker, cfg HostConfig) (*Host, error) {
	closeListeners := func() {
		if cfg.Catalog != nil {
			_ = cfg.Catalog.Close()
		}
		if cfg.Enrollment != nil {
			_ = cfg.Enrollment.Close()
		}
	}
	if b == nil {
		closeListeners()
		return nil, ErrInvalid
	}
	regs := append([]extension.Registration(nil), cfg.Registrations...)
	// Route last among request hooks. This makes destination/credentials one final
	// bound decision; no subsequent request transform can silently move the secret.
	var after []string
	for _, r := range regs {
		if r.Stage <= extension.Upstream {
			after = append(after, r.ID)
		}
	}
	regs = append(regs,
		extension.Registration{Owner: "broker", ID: "broker.retain", Stage: extension.Prepare, Body: extension.Whole, Before: after,
			Handler: func(ctx context.Context, in extension.Input) (extension.Result, error) {
				state, ok := ctx.Value(hostStateKey{}).(*hostState)
				if !ok {
					return extension.Result{}, ErrDenied
				}
				header := in.Request.Header.Clone()
				stripCallerHeaders(header)
				state.mu.Lock()
				state.attempts[in.Identity.Exchange] = hostAttempt{body: append([]byte(nil), in.Request.Body...), method: in.Request.Method, header: header}
				state.mu.Unlock()
				return extension.Result{}, nil
			}},
		extension.Registration{Owner: "broker", ID: "broker.lifecycle", Stage: extension.Prepare,
			Handler: func(context.Context, extension.Input) (extension.Result, error) { return extension.Result{}, nil },
			Setup: func(context.Context) error {
				_, err := Start(b, cfg.Catalog, cfg.Enrollment, cfg.ServiceToken, cfg.RetryInterval)
				return err
			},
			Cleanup: b.Close},
		extension.Registration{Owner: "broker", ID: "broker.route", Stage: extension.Upstream, Body: extension.Whole, After: after,
			Handler: func(ctx context.Context, in extension.Input) (extension.Result, error) {
				state, ok := ctx.Value(hostStateKey{}).(*hostState)
				if !ok || in.Auth.Subject == "" {
					return extension.Result{}, ErrAuth
				}
				callctx, end, err := b.begin(ctx)
				if err != nil {
					return extension.Result{}, ErrClosed
				}
				defer end()
				excluded := map[string]bool{}
				state.mu.Lock()
				if cfg.Select == nil {
					for k, v := range state.attempts[in.Identity.Parent].excluded {
						excluded[k] = v
					}
				}
				state.mu.Unlock()
				selection := Selection{}
				if cfg.Select != nil {
					selection, err = cfg.Select(callctx, in)
					if err != nil || selection.AccountID == "" || selection.Protocol == "" {
						return extension.Result{}, ErrDenied
					}
				}
				a, err := b.chooseAccount(callctx, in.Auth.Subject, excluded, selection.AccountID)
				if err != nil {
					return extension.Result{}, ErrDenied
				} // never publish raw callback errors
				if cfg.Select != nil && a.Endpoint != in.Request.URL {
					return extension.Result{}, ErrDenied
				}
				excluded[a.AccountID] = true
				u, err := url.Parse(a.Endpoint)
				if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || u.RawQuery != "" || (u.Scheme != "http" && u.Scheme != "https") {
					return extension.Result{}, ErrDenied
				}
				m := in.Request
				// Endpoint is the entire configured destination. Public paths/query/body do
				// not select an account or destination. Protocol/model conversion is not inferred.
				m.URL = u.String()
				stripCallerHeaders(m.Header)
				state.mu.Lock()
				saved := state.attempts[in.Identity.Exchange]
				saved.excluded = excluded
				if cfg.Select != nil {
					saved.evidence = Evidence{AccountID: a.AccountID, Provider: a.Provider, Model: a.Model, Endpoint: a.Endpoint, Protocol: selection.Protocol}
				}
				state.attempts[in.Identity.Exchange] = saved
				state.mu.Unlock()
				return extension.Result{Action: extension.Replace, Message: &m, Credentials: http.Header{"Authorization": {"Bearer " + a.Credential.Token}}, Metadata: map[string]string{"account": a.AccountID, "provider": a.Provider, "served_model": a.Model}}, nil
			}},
		extension.Registration{Owner: "broker", ID: "broker.fallback", Stage: extension.ResponseStart, Failure: extension.FailOpen,
			Handler: func(ctx context.Context, in extension.Input) (extension.Result, error) {
				// Explicit target selection is sticky: application-owned logical
				// reroutes must make fresh managed calls, never hidden fallback.
				if cfg.Select != nil || in.Response.Status < 500 {
					return extension.Result{}, nil
				}
				state, ok := ctx.Value(hostStateKey{}).(*hostState)
				if !ok {
					return extension.Result{}, ErrDenied
				}
				state.mu.Lock()
				a, ok := state.attempts[in.Identity.Exchange]
				state.mu.Unlock()
				// GET/HEAD/OPTIONS only: never replay POST, even with an idempotency header.
				if !ok || !safeReplayMethod(a.method) || !safeReplayMethod(in.Request.Method) {
					return extension.Result{}, nil
				}
				r, err := http.NewRequestWithContext(ctx, a.method, in.Request.URL, bytes.NewReader(a.body))
				if err != nil {
					return extension.Result{}, ErrInvalid
				}
				r.Header = a.header.Clone()
				// Fresh children carry no caller or provider credentials. Auth is inherited
				// by the engine; broker.route rechecks current ACL/endpoint/refresh state.
				return extension.Result{Action: extension.Child, Request: r}, nil
			}})
	e, err := extension.New(cfg.Execution, regs...)
	if err != nil {
		closeListeners()
		return nil, err
	}
	p, err := proxy.NewWithEngine("http://broker.invalid", e)
	if err != nil {
		_ = e.Close()
		return nil, err
	}
	h := &Host{Engine: e}
	h.transport = p.Transport.(interface{ CloseIdleConnections() })
	var ingress http.Handler = p
	if cfg.Ingress != nil {
		ingress = cfg.Ingress(ingress)
	}
	h.handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Trailer values arrive only after body reads. This small adapter rejects
		// declared trailers rather than forwarding late caller credential fields.
		if len(r.Trailer) != 0 {
			http.Error(w, "request trailers unsupported", http.StatusBadRequest)
			return
		}
		// Bind must precede auth. Remove bearer/cookie material BEFORE Bind captures
		// original facts, so independent observers cannot read ingress credentials.
		original := r
		r = r.Clone(r.Context())
		stripCallerHeaders(r.Header)
		var err error
		r, err = e.Bind(r)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		auth, ok := extension.AuthenticationFromContext(r.Context())
		if !ok || auth.Subject == "" {
			caller, err := b.authenticate(original)
			if err != nil {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			r = r.WithContext(extension.WithAuthentication(r.Context(), extension.Authentication{Subject: caller}))
		}
		ctx, end, err := b.begin(r.Context())
		if err != nil {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		defer end()
		ctx = context.WithValue(ctx, hostStateKey{}, &hostState{attempts: map[string]hostAttempt{}})
		ingress.ServeHTTP(w, r.WithContext(ctx))
	})
	return h, nil
}

func safeReplayMethod(method string) bool {
	return method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions
}

func stripCallerHeaders(h http.Header) {
	h.Del("Authorization")
	h.Del("Proxy-Authorization")
	h.Del("Cookie")
	h.Del("X-Caller-ID")
	h.Del("X-Account-ID")
}
func (h *Host) ServeHTTP(w http.ResponseWriter, r *http.Request) { h.handler.ServeHTTP(w, r) }
func (h *Host) Close(ctx context.Context) error {
	err := h.Engine.Shutdown(ctx)
	h.transport.CloseIdleConnections()
	return err
}
