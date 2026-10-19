package core

// Events publishes execution metadata to the runtime journal.
type Events struct {
	sink func(Event)
}

func NewEvents(sink func(Event)) *Events {
	return &Events{sink: sink}
}

func (events *Events) Publish(sessionID string, event Event) {
	if events == nil || events.sink == nil {
		return
	}
	event.SessionID = sessionID
	events.sink(event)
}
