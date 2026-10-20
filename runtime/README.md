# Apix Runtime

Local Go runtime service for Apix.

## Development

```bash
go run .
```

The service listens on `127.0.0.1:4317`.

By default the runtime stores SQLite data in `apix.db` relative to the
current working directory. Set `APIX_DB_PATH` to use an explicit database
file path instead. The root development command sets the existing durable
data directory; the standalone executable includes the Web workspace.

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

**Workspace**
- `GET /` — embedded Web workspace
- `GET /requests` — manual requests, saved interfaces, and execution history

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
- `POST /api/runs/:id/pin` — pin or unpin a run
- `DELETE /api/runs/:id` — delete a run
- `POST /api/import/curl` — import curl into a working copy

**Execution events**
- `GET /api/events?after=0` — persisted event metadata with a sequence cursor
- `GET /api/activity` — workspace activity, recent requests, and service logs
