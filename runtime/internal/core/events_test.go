package core

import "testing"

func TestEventsPublishRetainsExecutionMetadata(t *testing.T) {
	var received Event
	events := NewEvents(func(event Event) { received = event })
	events.Publish("session-1", Event{Type: EventStepDone, StepID: "step-1", Payload: "result"})
	if received.SessionID != "session-1" || received.StepID != "step-1" || received.Type != EventStepDone || received.Payload != "result" {
		t.Fatalf("execution metadata lost: %#v", received)
	}
}

func TestEventsWithoutJournal(t *testing.T) {
	NewEvents(nil).Publish("session-1", Event{Type: EventStepStart})
	var events *Events
	events.Publish("session-1", Event{Type: EventStepStart})
}
