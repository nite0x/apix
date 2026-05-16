# Sentris Runtime

Local Go runtime service for Sentris.

## Development

```bash
go run main.go
```

The service listens on `127.0.0.1:4317`.

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

**HTTP collections**
- `GET /api/http/collections` — list collections
- `POST /api/http/collections` — create collection
- `GET /api/http/collections/:cid` — get collection
- `PUT /api/http/collections/:cid` — update collection
- `DELETE /api/http/collections/:cid` — delete collection
- `POST /api/http/collections/:cid/requests` — add request
- `PUT /api/http/collections/:cid/requests/:rid` — update request
- `DELETE /api/http/collections/:cid/requests/:rid` — delete request

**WebSocket**
- `GET /ws/logs` — live event stream
