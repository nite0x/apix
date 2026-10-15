package core

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Hub struct {
	mu      sync.RWMutex
	writeMu sync.Mutex
	sink    func(Event)
	clients map[string][]*websocket.Conn
	global  []*websocket.Conn
}

func (h *Hub) SetEventSink(sink func(Event)) { h.sink = sink }

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
	if h.sink != nil {
		h.sink(event)
	}
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	h.writeMu.Lock()
	defer h.writeMu.Unlock()
	h.mu.RLock()
	connections := append([]*websocket.Conn(nil), h.global...)
	h.mu.RUnlock()
	for _, conn := range connections {
		_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			h.Unregister(conn)
			_ = conn.Close()
		}
	}
}
