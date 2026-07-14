# Apix Runtime

Local Go runtime service for Apix.

## Development

```bash
go run main.go
```

The service listens on `127.0.0.1:4317`.

By default the runtime stores SQLite data in `apix.db` relative to the
current working directory. Set `APIX_DB_PATH` to use an explicit database
file path instead; the desktop app does this when it launches the bundled
runtime sidecar.

## Endpoints

**Health**
- `GET /health`

**Sessions**
- `GET /api/sessions` — list all sessions
- `GET /api/sessions/:id` — get one session

**Steps**
- `POST /api/steps/:id/resume` — resume a paused step

**Rules**
- `GET /api/rules` — list rules
- `PUT /api/rules` — update rules

**Manual execution**
- `POST /manual` — execute one direct HTTP request from the desktop UI

**HTTP domain (v2)**
- `GET /api/collections` — list collections
- `POST /api/collections` — create collection
- `PATCH /api/collections/:id` — update collection
- `DELETE /api/collections/:id` — archive collection
- `GET /api/requests?collection_id=` — list requests in a collection
- `POST /api/requests` — create request
- `GET /api/requests/:id` — get request
- `PUT /api/requests/:id` — update request
- `DELETE /api/requests/:id` — archive request
- `POST /api/working-copies` — create working copy
- `GET /api/working-copies/:id` — get working copy
- `PUT /api/working-copies/:id` — update working copy
- `POST /api/working-copies/:id/save` — save working copy to a request
- `POST /api/working-copies/:id/discard` — discard working copy
- `POST /api/runs` — execute a saved request or working copy
- `GET /api/runs` — list recent runs
- `GET /api/runs/:id` — get one run
- `POST /api/import/curl` — import curl into a working copy

**WebSocket**
- `GET /ws/logs` — live event stream
