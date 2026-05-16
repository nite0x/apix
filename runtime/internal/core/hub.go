package core

import (
	"encoding/json"
	"sync"

	"github.com/gorilla/websocket"
)

type Hub struct {
	mu      sync.RWMutex
	clients map[string][]*websocket.Conn
	global  []*websocket.Conn
}

func NewHub() *Hub {
	return &Hub{
		clients: make(map[string][]*websocket.Conn),
	}
}

func (h *Hub) RegisterGlobal(conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.global = append(h.global, conn)
}

func (h *Hub) Unregister(conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	newGlobal := make([]*websocket.Conn, 0)
	for _, c := range h.global {
		if c != conn {
			newGlobal = append(newGlobal, c)
		}
	}
	h.global = newGlobal
}

func (h *Hub) Push(sessionID string, event Event) {
	event.SessionID = sessionID
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, conn := range h.global {
		conn.WriteMessage(websocket.TextMessage, data) //nolint:errcheck
	}
}
