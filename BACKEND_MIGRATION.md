# Suggested backend migration

When moving from localStorage to a backend:

POST /api/cases
GET /api/cases/:id
GET /api/cases/:id/rankings
POST /api/cases/:id/requests
POST /api/requests/:id/accept
POST /api/requests/:id/reject
POST /api/cases/:id/override
POST /api/cases/:id/handoff
PATCH /api/hospitals/:id/resources
GET /api/hospitals
GET /api/ambulances
GET /api/audit

Use a transaction for:
1. Read current hospital resource counts.
2. Verify required resources >= request.
3. Decrement resources.
4. Insert reservation.
5. Mark request accepted.
6. Mark case assigned.
7. Commit.

Publish the resulting state over WebSocket/SSE so ambulance, hospital and dispatcher clients update immediately.
