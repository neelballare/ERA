# ERA — Emergency Resource Allocator

The current application is a full-stack local demo with:

- `backend/`: FastAPI + SQLAlchemy + SQLite API and seeded operational data.
- `frontend/`: React + Vite interface with role-based ambulance, hospital, and dispatcher workspaces.
- Responsive healthcare-focused UI designed for desktop dispatch and mobile ambulance use.

## Full-stack setup

Requirements: Python 3.11+ and Node.js 18+.

1. Install backend dependencies:

	```powershell
	python -m pip install -r backend/requirements.txt
	```

2. Start the API from the project root:

	```powershell
	python -m uvicorn backend.main:app --reload --port 8000
	```

	The API is available at `http://localhost:8000`. Interactive API docs are at `http://localhost:8000/docs`.

3. In a second terminal, install and start the React frontend:

	```powershell
	Set-Location frontend
	npm install
	npm run dev
	```

	Open `http://localhost:5173`.

SQLite is created automatically at `backend/era.db` on first API startup. The seeded demo accounts are listed below. This setup is intended for local evaluation; production deployment should add real authentication, migrations, secrets management, PostgreSQL, and a server-side event channel.

## Demo accounts

- Dispatcher: `dispatcher` / `dispatch123`
- Ambulance: `ambulance1` / `amb123` through `ambulance4` / `amb123`
- Hospital: `hospital1` / `hosp123` through `hospital4` / `hosp123`

The main workflow is ready to test: sign in as an ambulance operator, create a case, sign in as the selected hospital in another browser session, accept the request, then inspect the assigned state as dispatcher.

The API publishes role-scoped updates over `ws://localhost:8000/ws?token=<login-token>`. Dispatchers receive all events; ambulance and hospital clients receive events for their associated records. The backend allocation engine, reservation boundary, and focused tests are under `backend/services/` and `backend/tests/`.

## Dispatcher demonstration flow

1. Sign in as `dispatcher` and open **Command center**. The live network board shows all ambulances, all hospitals, their statuses, coordinates, and available units.
2. Open **Simulation lab** and run **Create live critical emergency**. This creates a real case and primary/standby hospital requests through the normal allocation services.
3. Open the selected hospital in another browser session using the matching account (`H-01` maps to `hospital1`, `H-02` to `hospital2`, and so on). Accept the request.
4. Return to the dispatcher. The ambulance changes to `EN_ROUTE`; its destination is persisted and the network map draws the current route. A background worker advances the simulated ambulance position and broadcasts `ambulance.updated` events.
5. Run **Simulate hospital rejection** or **Force request timeout** to demonstrate reallocation. The pending hospital changes, the route target changes after acceptance, and the audit trail records the reason.
6. Use **Prepare double booking** to set H-01 to one ICU bed, then create competing critical cases to demonstrate reservation conflict behavior. **Reset demonstration** clears simulation cases and restores seeded capacities.

## Legacy static MVP

The original no-build implementation remains in `index.html`, `app.js`, and `styles.css` for reference. The React/FastAPI stack above is the new application entry point.

---

# ERA — Emergency Resource Allocator MVP

A local-first, single web application demonstrating the complete emergency hospital allocation workflow.

## What is included

### Three role-based workspaces
- **Ambulance operators:** create patient/emergency cases, specify severity and resource requirements, see hospital request state, confirmed destination, route map, reallocation history and ranking snapshot.
- **Hospitals:** manage simulated availability, receive requests, accept/reject, and reserve resources.
- **Dispatcher:** command center with all active cases, ambulance fleet, hospital resources, ranking factors, case inspection, manual override, handoff completion and scenario simulator.

### Allocation engine
Hospitals are scored using:
- Resource match: 45%
- Travel time: 25%
- Data freshness: 15%
- Capacity confidence: 15%

Mandatory resource mismatches are treated as ineligible / heavily penalized.
Critical cases receive additional travel-time pressure.
Acceptance performs a second live capacity check before reservation.

### Failure scenarios
- Hospital rejection → automatic re-ranking/reallocation
- Hospital timeout → automatic re-ranking/reallocation
- Stale hospital data → freshness penalty
- Simultaneous ICU request → reservation conflict prevents double booking
- Dispatcher override → manually choose a ranked hospital and send a new confirmation request

## Run

No build step is required.

Option A: double-click `index.html`.

Option B (recommended):
```bash
python -m http.server 5500
```
Then open:
http://localhost:5500

The map uses Leaflet + OpenStreetMap tiles, so an internet connection is required for the map tiles. The core application and state are local.

## Demo accounts

Dispatcher:
- username: `dispatcher`
- password: `dispatch123`

Ambulances:
- `ambulance1` / `amb123`
- `ambulance2` / `amb123`
- `ambulance3` / `amb123`
- `ambulance4` / `amb123`

Hospitals:
- `hospital1` / `hosp123`
- `hospital2` / `hosp123`
- `hospital3` / `hosp123`
- `hospital4` / `hosp123`

## Multi-role live demo

Open the same app in multiple browser tabs/windows and sign in with different roles.

State is stored in browser `localStorage`, and changes trigger a browser `storage` event so the other tabs refresh automatically.

Suggested demo:
1. Tab 1 → dispatcher
2. Tab 2 → ambulance1
3. Tab 3 → hospital1
4. Ambulance creates a critical case requiring ICU + ventilator + trauma.
5. Dispatcher watches the ranked hospitals.
6. Hospital receives the request and accepts it.
7. Ambulance sees the confirmed hospital and route.
8. Dispatcher opens the case and completes handoff.
9. Try rejection or timeout to demonstrate automatic reallocation.
10. Dispatcher → Scenario Simulator → Double-booking test.

## Architecture

The current MVP deliberately keeps the backend out of the critical path:
- `app.js` contains domain logic, ranking engine, state model and UI.
- `localStorage` acts as the temporary data store.
- Browser storage events act as a lightweight cross-tab synchronization mechanism.

For the next version, move the following into a backend/API + database:
- users/authentication
- hospitals/resources
- cases
- requests
- reservations
- audit events
- atomic reservation transaction
- WebSocket/SSE live updates
- real routing/ETA service

## Important MVP limitation

Browser `localStorage` is suitable for demonstration, not production. It does not provide database-grade transactions, authentication or multi-user security. The reservation function includes a short local lock and re-checks current capacity immediately before reserving, which is enough to demonstrate the conflict flow in the MVP. A production version should use a server-side transaction/row lock or optimistic concurrency control.
