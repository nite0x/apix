package core

import (
	"sort"
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
	sm := &SessionManager{
		sessions: make(map[string]*Session),
		store:    store,
	}
	for _, session := range store.ListSessions() {
		session.Steps = store.LoadSteps(session.ID)
		sm.sessions[session.ID] = session
	}
	return sm
}

func (sm *SessionManager) Create(sessionType SessionType, task string, source string) *Session {
	return sm.create("", sessionType, task, source)
}

func (sm *SessionManager) create(id string, sessionType SessionType, task string, source string) *Session {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if id == "" {
		id = uuid.New().String()
	}
	s := &Session{
		ID:        id,
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
	return sm.create(id, SessionTypeAI, task, source)
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
	sort.Slice(list, func(i, j int) bool {
		return list[i].CreatedAt.After(list[j].CreatedAt)
	})
	return list
}
