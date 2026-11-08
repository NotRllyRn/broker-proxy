package brokerapp

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"time"
)

type CatalogEntry struct {
	ID       string         `json:"id"`
	Label    string         `json:"label"`
	Provider string         `json:"provider"`
	Model    string         `json:"model"`
	Quota    *QuotaSnapshot `json:"quota,omitempty"`
}

// CatalogHandler demonstrates an arbitrary extension-owned authenticated HTTP
// endpoint. Identity headers/query/body fields never participate in auth.
func (b *Broker) CatalogHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		caller, err := b.authenticate(r)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_, end, err := b.begin(r.Context())
		if err != nil {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		defer end()
		if r.Method != http.MethodGet || r.URL.Path != "/catalog" {
			http.NotFound(w, r)
			return
		}
		if b.store.snapshot().Accounts == nil {
			http.Error(w, "catalog unavailable", http.StatusServiceUnavailable)
			return
		}
		entries := []CatalogEntry{}
		for _, a := range b.store.accounts() {
			if !eligible(a, caller) || !b.endpoints[a.Endpoint] {
				continue
			}
			entry := CatalogEntry{ID: a.ID, Label: a.Label, Provider: a.Provider, Model: a.Model}
			b.mu.Lock()
			if q, ok := b.quotas[a.ID]; ok {
				entry.Quota = &q
			}
			b.mu.Unlock()
			entries = append(entries, entry)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(entries)
	})
}

func (b *Broker) enrollmentHandler(serviceHash [32]byte) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		actual := sha256.Sum256([]byte(bearer(r)))
		if subtle.ConstantTimeCompare(actual[:], serviceHash[:]) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ctx, end, err := b.begin(r.Context())
		if err != nil {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		defer end()
		if r.Method != http.MethodPost || r.URL.Path != "/enroll" {
			http.NotFound(w, r)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		var a Account
		if dec.Decode(&a) != nil || dec.Decode(new(any)) != io.EOF || validateAccount(a) != nil || !b.endpoints[a.Endpoint] {
			http.Error(w, "invalid enrollment", http.StatusBadRequest)
			return
		}
		if ctx.Err() != nil {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		if b.store.Activate(a) != nil {
			http.Error(w, "activation unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusCreated)
	})
}

// Application owns two separate listeners, servers and one retry worker.
// The enrollment listener is service-authenticated, not a public OAuth flow.
// Supply loopback listeners for this proof; remote deployment needs TLS and
// independent service credential provisioning, request limits and supervision.
type Application struct {
	broker              *Broker
	catalog, enrollment *http.Server
}

// Start takes ownership of both listeners, including on validation failure.
// Retry interval must be positive. Pending notifications are tried on startup.
func Start(b *Broker, catalog, enrollment net.Listener, serviceToken string, retry time.Duration) (*Application, error) {
	fail := func() (*Application, error) {
		if catalog != nil {
			catalog.Close()
		}
		if enrollment != nil {
			enrollment.Close()
		}
		return nil, ErrInvalid
	}
	if b == nil || catalog == nil || enrollment == nil || serviceToken == "" || retry <= 0 {
		return fail()
	}
	hash := sha256.Sum256([]byte(serviceToken))
	if _, reused := b.callers[hash]; reused {
		return fail()
	}
	app := &Application{broker: b,
		catalog:    &http.Server{Handler: b.CatalogHandler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second},
		enrollment: &http.Server{Handler: b.enrollmentHandler(hash), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second}}
	b.mu.Lock()
	if b.closed || b.cleanup != nil {
		b.mu.Unlock()
		return fail()
	}
	b.cleanup = func() {
		_ = app.catalog.Close()
		_ = app.enrollment.Close()
	}
	b.wg.Add(3)
	b.mu.Unlock()
	go func() { defer b.wg.Done(); _ = app.catalog.Serve(catalog) }()
	go func() { defer b.wg.Done(); _ = app.enrollment.Serve(enrollment) }()
	go func() {
		defer b.wg.Done()
		timer := time.NewTicker(retry)
		defer timer.Stop()
		for {
			_ = b.FlushNotifications(b.ctx)
			select {
			case <-b.ctx.Done():
				return
			case <-timer.C:
			}
		}
	}()
	return app, nil
}

// Close cancels admission/work, closes HTTP connections/listeners, then waits
// for owned servers/jobs/requests. It is safe to call again after a timeout.
func (a *Application) Close(ctx context.Context) error {
	return a.broker.Close(ctx)
}
