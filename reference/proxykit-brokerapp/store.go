// Package brokerapp is a trusted, extension-owned broker application proof.
// It is independent of the host extension API and is not an HTTP proxy.
package brokerapp

import (
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

var (
	ErrAuth     = errors.New("broker: authentication required")
	ErrDenied   = errors.New("broker: no eligible account")
	ErrClosed   = errors.New("broker: admission closed")
	ErrStore    = errors.New("broker: durable store unavailable")
	ErrRefresh  = errors.New("broker: credential refresh failed")
	ErrDispatch = errors.New("broker: dispatch failed")
	ErrInvalid  = errors.New("broker: invalid configuration or account")
)

type Credential struct {
	Token   string    `json:"token"`
	Expires time.Time `json:"expires"`
}

// Account is trusted enrollment input, never a caller-visible catalog entry.
// Endpoint is an exact destination, not a caller-supplied URL or redirect target.
type Account struct {
	ID         string     `json:"id"`
	Label      string     `json:"label"`
	Callers    []string   `json:"callers"`
	Endpoint   string     `json:"endpoint"`
	Provider   string     `json:"provider"`
	Model      string     `json:"model"`
	Credential Credential `json:"credential"`
	Active     bool       `json:"active"`
	Revision   uint64     `json:"revision"`
}

type Notification struct {
	ID        uint64 `json:"id"`
	AccountID string `json:"account_id"`
	Label     string `json:"label"`
}

type diskState struct {
	Accounts map[string]Account `json:"accounts"`
	Outbox   []Notification     `json:"outbox"`
	NextID   uint64             `json:"next_id"`
}

// Store requires exclusive single-process ownership of its private directory.
// It does not implement interprocess locking, encryption or multi-replica CAS.
// All mutations copy, persist and only then publish the new state.
type Store struct {
	mu       sync.Mutex
	path     string
	state    diskState
	poisoned bool
	persist  func(string, []byte) error
}

func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, ErrStore
	}
	s := &Store{path: filepath.Join(dir, "broker.json"), state: diskState{Accounts: map[string]Account{}}, persist: atomicFile}
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil || json.Unmarshal(data, &s.state) != nil || s.state.Accounts == nil {
		return nil, ErrStore
	}
	for id, a := range s.state.Accounts {
		if id != a.ID || validateAccount(a) != nil {
			return nil, ErrStore
		}
	}
	return s, nil
}

func validateAccount(a Account) error {
	u, err := url.Parse(a.Endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" ||
		a.ID == "" || a.Label == "" || a.Provider == "" || a.Model == "" || a.Credential.Token == "" || len(a.Callers) == 0 {
		return ErrInvalid
	}
	return nil
}

func atomicFile(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".broker-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func (s *Store) snapshot() diskState {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.poisoned {
		return diskState{}
	}
	return cloneState(s.state)
}

func cloneState(in diskState) diskState {
	out := diskState{Accounts: make(map[string]Account, len(in.Accounts)), Outbox: append([]Notification(nil), in.Outbox...), NextID: in.NextID}
	for k, a := range in.Accounts {
		a.Callers = append([]string(nil), a.Callers...)
		out.Accounts[k] = a
	}
	return out
}

func (s *Store) commit(next diskState) error {
	if s.poisoned {
		return ErrStore
	}
	data, err := json.Marshal(next)
	if err != nil {
		return ErrStore
	}
	if err = s.persist(s.path, data); err != nil {
		// A post-rename fsync error is an uncertain commit. Fail closed until reopen;
		// disk recovery may contain the complete transaction, never a partial one.
		s.poisoned = true
		return ErrStore
	}
	s.state = next
	return nil
}

// Activate commits account, labels/ACLs and a stable-ID outbox entry together.
// Reactivation/revocation is also a transaction and emits a new notification.
func (s *Store) Activate(a Account) error {
	if validateAccount(a) != nil {
		return ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := cloneState(s.state)
	a.Callers = append([]string(nil), a.Callers...)
	a.Revision = next.Accounts[a.ID].Revision + 1
	next.Accounts[a.ID] = a
	next.NextID++
	next.Outbox = append(next.Outbox, Notification{ID: next.NextID, AccountID: a.ID, Label: a.Label})
	return s.commit(next)
}

func (s *Store) replaceCredential(id string, revision uint64, c Credential) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.state.Accounts[id]
	if !ok || a.Revision != revision {
		return ErrRefresh
	}
	next := cloneState(s.state)
	a.Credential = c
	a.Revision++
	next.Accounts[id] = a
	return s.commit(next)
}

func (s *Store) acknowledge(id uint64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := cloneState(s.state)
	for i, n := range next.Outbox {
		if n.ID == id {
			next.Outbox = append(next.Outbox[:i], next.Outbox[i+1:]...)
			return s.commit(next)
		}
	}
	return nil
}

func (s *Store) accounts() []Account {
	state := s.snapshot()
	out := make([]Account, 0, len(state.Accounts))
	for _, a := range state.Accounts {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
