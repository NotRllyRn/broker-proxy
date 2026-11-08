package brokerapp

import (
	"context"
	"crypto/sha256"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Config is copied at construction. Tokens map to identities, never vice versa.
// Callbacks are trusted, must honor cancellation and must not log credentials.
type Config struct {
	CallerTokens     map[string]string
	AllowedEndpoints []string
	Refresh          func(context.Context, string, Credential) (Credential, error)
	Notify           func(context.Context, Notification) error
}

type QuotaSnapshot struct {
	Remaining  int64     `json:"remaining"`
	ObservedAt time.Time `json:"observed_at"`
}

// Usage is provider-reported usage. Nil means unknown, never zero.
type Usage struct{ InputTokens, OutputTokens int64 }

// Attempt is given only to a trusted managed dispatcher, not to observers.
// The dispatcher must construct fresh authentication for Endpoint, avoid
// redirects (or reauthorize them), and never reuse inbound Authorization.
type Attempt struct {
	AccountID, Provider, Model, Endpoint string
	Credential                           Credential
}

type AttemptResult struct {
	Status int
	Usage  *Usage
}

type Dispatcher interface {
	Dispatch(context.Context, Attempt) (AttemptResult, error)
}

// Outcome deliberately excludes endpoint, credential, headers and callback errors.
type Outcome struct {
	Caller, AccountID, RequestedModel, Provider, ServedModel string
	Status                                                   int
	Failed                                                   bool
	Usage                                                    *Usage
}

type flight struct {
	done chan struct{}
	err  error
}

type Broker struct {
	store     *Store
	callers   map[[32]byte]string
	endpoints map[string]bool
	refresh   func(context.Context, string, Credential) (Credential, error)
	notify    func(context.Context, Notification) error
	ctx       context.Context
	cancel    context.CancelFunc
	mu        sync.Mutex
	closed    bool
	flights   map[string]*flight
	quotas    map[string]QuotaSnapshot
	wg        sync.WaitGroup
	stop      sync.Once
	done      chan struct{}
	delivery  sync.Mutex
	cleanup   func()
}

func New(store *Store, cfg Config) (*Broker, error) {
	if store == nil || len(cfg.CallerTokens) == 0 || len(cfg.AllowedEndpoints) == 0 {
		return nil, ErrInvalid
	}
	ctx, cancel := context.WithCancel(context.Background())
	b := &Broker{store: store, callers: map[[32]byte]string{}, endpoints: map[string]bool{}, refresh: cfg.Refresh, notify: cfg.Notify,
		ctx: ctx, cancel: cancel, flights: map[string]*flight{}, quotas: map[string]QuotaSnapshot{}, done: make(chan struct{})}
	for token, id := range cfg.CallerTokens {
		if token == "" || id == "" {
			cancel()
			return nil, ErrInvalid
		}
		b.callers[sha256.Sum256([]byte(token))] = id
	}
	for _, endpoint := range cfg.AllowedEndpoints {
		b.endpoints[endpoint] = true
	}
	return b, nil
}

func bearer(r *http.Request) string {
	values := r.Header.Values("Authorization")
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(values[0], "Bearer ")
}

func (b *Broker) authenticate(r *http.Request) (string, error) {
	id := b.callers[sha256.Sum256([]byte(bearer(r)))]
	if id == "" {
		return "", ErrAuth
	}
	return id, nil
}

func (b *Broker) begin(parent context.Context) (context.Context, func(), error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil, nil, ErrClosed
	}
	b.wg.Add(1)
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(b.ctx, cancel)
	return ctx, func() { stop(); cancel(); b.wg.Done() }, nil
}

func (b *Broker) shutdown() {
	b.stop.Do(func() {
		b.mu.Lock()
		b.closed = true
		b.cancel()
		cleanup := b.cleanup
		b.mu.Unlock()
		if cleanup != nil {
			cleanup()
		}
		go func() { b.wg.Wait(); close(b.done) }()
	})
}

// Close stops admission, cancels requests/refresh/jobs, closes any Application
// listeners/connections, and awaits owned work. A timeout cannot forcibly
// terminate uncooperative trusted callbacks; another Close can await completion.
func (b *Broker) Close(ctx context.Context) error {
	b.shutdown()
	select {
	case <-b.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func eligible(a Account, caller string) bool {
	if !a.Active {
		return false
	}
	for _, id := range a.Callers {
		if id == caller {
			return true
		}
	}
	return false
}

func (b *Broker) choose(ctx context.Context, caller string, excluded map[string]bool) (Attempt, error) {
	return b.chooseAccount(ctx, caller, excluded, "")
}

// chooseAccount retains ordinary selection when id is empty. Explicit selection
// still rechecks live ACL, destination allowlist and refreshed committed state.
func (b *Broker) chooseAccount(ctx context.Context, caller string, excluded map[string]bool, id string) (Attempt, error) {
	if b.store.snapshot().Accounts == nil {
		return Attempt{}, ErrStore
	}
	for _, a := range b.store.accounts() {
		if (id != "" && a.ID != id) || excluded[a.ID] || !eligible(a, caller) || !b.endpoints[a.Endpoint] {
			continue
		}
		if !a.Credential.Expires.After(time.Now()) {
			if err := b.renew(ctx, a.ID); err != nil {
				return Attempt{}, err
			}
		}
		// Refresh is asynchronous application work. Re-read committed policy after it.
		current, ok := b.store.snapshot().Accounts[a.ID]
		if !ok || !eligible(current, caller) || !b.endpoints[current.Endpoint] {
			continue
		}
		if !current.Credential.Expires.After(time.Now()) {
			return Attempt{}, ErrRefresh
		}
		return Attempt{AccountID: current.ID, Provider: current.Provider, Model: current.Model, Endpoint: current.Endpoint, Credential: current.Credential}, nil
	}
	return Attempt{}, ErrDenied
}

func (b *Broker) renew(ctx context.Context, id string) error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return ErrClosed
	}
	f := b.flights[id]
	if f == nil {
		// Recheck under the singleflight lock: a just-finished flight may be gone.
		a := b.store.snapshot().Accounts[id]
		if a.Credential.Expires.After(time.Now()) {
			b.mu.Unlock()
			return nil
		}
		f = &flight{done: make(chan struct{})}
		b.flights[id] = f
		b.wg.Add(1)
		go func() {
			defer b.wg.Done()
			var c Credential
			var err error
			if b.refresh == nil {
				err = ErrRefresh
			} else {
				c, err = b.refresh(b.ctx, id, a.Credential)
			}
			if err == nil && c.Token != "" && c.Expires.After(time.Now()) {
				err = b.store.replaceCredential(id, a.Revision, c)
			} else {
				err = ErrRefresh
			}
			b.mu.Lock()
			if err != nil {
				f.err = ErrRefresh
			}
			delete(b.flights, id)
			close(f.done)
			b.mu.Unlock()
		}()
	}
	b.mu.Unlock()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-f.done:
		return f.err
	}
}

// Execute is the later host bridge: authenticate once and make bounded,
// request-local attempts. Each fallback rechecks current committed ACLs.
// A failed attempt is eligible for fallback; successful 2xx/3xx/4xx is final.
// Nothing is delivered to a client here, so no committed response is retried.
// requested is provenance, not authority to choose an account or identity.
func (b *Broker) Execute(r *http.Request, requested string, maxAttempts int, d Dispatcher) (AttemptResult, []Outcome, error) {
	if maxAttempts < 1 || d == nil {
		return AttemptResult{}, nil, ErrInvalid
	}
	caller, err := b.authenticate(r)
	if err != nil {
		return AttemptResult{}, nil, err
	}
	ctx, end, err := b.begin(r.Context())
	if err != nil {
		return AttemptResult{}, nil, err
	}
	defer end()
	excluded := map[string]bool{}
	var outcomes []Outcome
	var result AttemptResult
	for i := 0; i < maxAttempts; i++ {
		if err := ctx.Err(); err != nil {
			return result, outcomes, err
		}
		a, err := b.choose(ctx, caller, excluded)
		if err != nil {
			return result, outcomes, err
		}
		excluded[a.AccountID] = true
		result, err = d.Dispatch(ctx, a)
		failed := err != nil || result.Status >= 500 || result.Status < 200
		var usage *Usage
		if result.Usage != nil {
			copy := *result.Usage
			usage = &copy
		}
		outcomes = append(outcomes, Outcome{Caller: caller, AccountID: a.AccountID, RequestedModel: requested, Provider: a.Provider, ServedModel: a.Model, Status: result.Status, Failed: failed, Usage: usage})
		if !failed {
			return result, outcomes, nil
		}
	}
	return result, outcomes, ErrDispatch
}

// UpdateQuota is a trusted application input. It does not synthesize Usage.
func (b *Broker) UpdateQuota(account string, q QuotaSnapshot) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.quotas[account] = q
}

// FlushNotifications is serialized with the background worker. Receiver must
// deduplicate stable IDs: a crash after delivery and before ack causes retry.
func (b *Broker) FlushNotifications(ctx context.Context) error {
	ctx, end, err := b.begin(ctx)
	if err != nil {
		return err
	}
	defer end()
	b.delivery.Lock()
	defer b.delivery.Unlock()
	state := b.store.snapshot()
	if state.Accounts == nil {
		return ErrStore
	}
	for _, n := range state.Outbox {
		if err := ctx.Err(); err != nil {
			return err
		}
		if b.notify == nil || b.notify(ctx, n) != nil {
			return ErrDispatch
		}
		if err := b.store.acknowledge(n.ID); err != nil {
			return err
		}
	}
	return nil
}
