package httpapi

import (
	"fmt"
	"sync"

	"github.com/google/uuid"
)

// Collection groups related API requests together.
type Collection struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	BaseURL  string    `json:"base_url,omitempty"`
	Requests []Request `json:"requests"`
}

// Request is a saved HTTP request definition.
type Request struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
}

// collectionStore is an in-memory store for HTTP collections.
type collectionStore struct {
	mu   sync.RWMutex
	data map[string]*Collection
}

func newCollectionStore() *collectionStore {
	return &collectionStore{data: make(map[string]*Collection)}
}

func (s *collectionStore) list() []*Collection {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Collection, 0, len(s.data))
	for _, c := range s.data {
		out = append(out, c)
	}
	return out
}

func (s *collectionStore) get(id string) (*Collection, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.data[id]
	return c, ok
}

func (s *collectionStore) create(name, baseURL string) *Collection {
	c := &Collection{
		ID:       uuid.New().String(),
		Name:     name,
		BaseURL:  baseURL,
		Requests: []Request{},
	}
	s.mu.Lock()
	s.data[c.ID] = c
	s.mu.Unlock()
	return c
}

func (s *collectionStore) update(id, name, baseURL string) (*Collection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.data[id]
	if !ok {
		return nil, fmt.Errorf("collection %s not found", id)
	}
	c.Name = name
	c.BaseURL = baseURL
	return c, nil
}

func (s *collectionStore) delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.data[id]
	if ok {
		delete(s.data, id)
	}
	return ok
}

func (s *collectionStore) addRequest(collectionID string, req Request) (*Collection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.data[collectionID]
	if !ok {
		return nil, fmt.Errorf("collection %s not found", collectionID)
	}
	req.ID = uuid.New().String()
	c.Requests = append(c.Requests, req)
	return c, nil
}

func (s *collectionStore) updateRequest(collectionID, requestID string, req Request) (*Collection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.data[collectionID]
	if !ok {
		return nil, fmt.Errorf("collection %s not found", collectionID)
	}
	for i, r := range c.Requests {
		if r.ID == requestID {
			req.ID = requestID
			c.Requests[i] = req
			return c, nil
		}
	}
	return nil, fmt.Errorf("request %s not found", requestID)
}

func (s *collectionStore) deleteRequest(collectionID, requestID string) (*Collection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.data[collectionID]
	if !ok {
		return nil, fmt.Errorf("collection %s not found", collectionID)
	}
	for i, r := range c.Requests {
		if r.ID == requestID {
			c.Requests = append(c.Requests[:i], c.Requests[i+1:]...)
			return c, nil
		}
	}
	return nil, fmt.Errorf("request %s not found", requestID)
}
