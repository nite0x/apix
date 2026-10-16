package httpapi

import (
	"testing"
	"time"
)

func TestListRequestsReleasesSingleSQLiteConnection(t *testing.T) {
	service, _ := newTestRouter(t)
	service.db.SetMaxOpenConns(1)
	collection := &APICollection{Name: "Single connection requests"}
	if err := service.repo.createCollection(collection); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"one", "two"} {
		request := &APIRequest{CollectionID: collection.ID, Name: name,
			Request: RequestData{Method: "GET", URL: "https://example.com/" + name}}
		if err := service.repo.createRequest(request); err != nil {
			t.Fatal(err)
		}
	}
	requests, err := service.repo.listRequests(collection.ID)
	if err != nil || len(requests) != 2 {
		t.Fatalf("list requests: count=%d, err=%v", len(requests), err)
	}
	var count int
	if err := service.db.QueryRow("SELECT COUNT(*) FROM api_requests").Scan(&count); err != nil || count != 2 {
		t.Fatalf("connection was not released: count=%d err=%v", count, err)
	}
}

func TestListRunsReleasesSingleSQLiteConnection(t *testing.T) {
	service, _ := newTestRouter(t)
	service.db.SetMaxOpenConns(1)
	for _, id := range []string{"single-connection-run-one", "single-connection-run-two"} {
		run := &APIRun{ID: id, ProjectID: "single-connection-project", TriggerType: "manual", Status: "succeeded",
			StartedAt: time.Now().UTC(), RequestSnapshot: RequestData{Method: "GET", URL: "https://example.com"}}
		if err := service.repo.insertRun(run); err != nil {
			t.Fatal(err)
		}
	}
	runs, err := service.repo.listRuns("single-connection-project", 50)
	if err != nil || len(runs) != 2 {
		t.Fatalf("list runs: count=%d, err=%v", len(runs), err)
	}
	var count int
	if err := service.db.QueryRow("SELECT COUNT(*) FROM api_runs WHERE project_id=?", "single-connection-project").Scan(&count); err != nil || count != 2 {
		t.Fatalf("connection was not released: count=%d err=%v", count, err)
	}
}
