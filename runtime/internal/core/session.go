package core

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

type SessionManager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	store    Store
}

func NewSessionManager(store Store) *SessionManager {
	return &SessionManager{
		sessions: make(map[string]*Session),
		store:    store,
	}
}

func (sm *SessionManager) Create(sessionType SessionType, task string, source string) *Session {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	s := &Session{
		ID:        uuid.New().String(),
		Type:      sessionType,
		Status:    SessionRunning,
		Task:      task,
		Source:    source,
		Steps:     make([]*Step, 0),
		Variables: NewVariables(),
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	sm.sessions[s.ID] = s
	sm.store.SaveSession(s)
	return s
}

func (sm *SessionManager) Get(id string) (*Session, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	s, ok := sm.sessions[id]
	return s, ok
}

func (sm *SessionManager) GetOrCreate(id string, task string, source string) *Session {
	if s, ok := sm.Get(id); ok {
		return s
	}
	return sm.Create(SessionTypeAI, task, source)
}

func (sm *SessionManager) UpdateStatus(id string, status SessionStatus) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if s, ok := sm.sessions[id]; ok {
		s.Status = status
		s.UpdatedAt = time.Now()
		sm.store.SaveSession(s)
	}
}

func (sm *SessionManager) List() []*Session {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	list := make([]*Session, 0, len(sm.sessions))
	for _, s := range sm.sessions {
		list = append(list, s)
	}
	return list
}
