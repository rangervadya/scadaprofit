# Integration tests

End-to-end API tests that boot the real server against a real PostgreSQL
database. Unlike the unit tests (which mostly assert on source files), these
exercise routing, Prisma queries, session cookies and the business flows the UI
depends on.

They exist as the safety net for the monolith split (P2-1): after moving routes
and domain logic out of `server.js` / `workforce-system.js`, these must stay
green.

## Run locally

```bash
# 1. Create a scratch database (once)
PGPASSWORD=vdgo psql postgresql://vdgo@localhost:55432/postgres \
  -c "CREATE DATABASE vdgo_itest OWNER vdgo;"

# 2. Apply migrations to it
npm --prefix services/ollama run db:deploy:test

# 3. Run
INTEGRATION=1 \
INTEGRATION_DATABASE_URL=postgresql://vdgo:vdgo@localhost:55432/vdgo_itest \
npm --prefix services/ollama run test:integration
```

`INTEGRATION=1` is required: without it the suite is skipped so `npm test` stays
fast and needs no database.

## What is covered

`tests/node/integration/api.test.js`

- health / readiness
- anonymous access is rejected on protected endpoints
- login → session → `/api/auth/me`
- wrong password does not create a session
- logout invalidates the session

`tests/node/integration/business-flows.test.js`

- bootstrap (users + task summary)
- create fitter, appears in the user list
- duplicate username rejected (409)
- multi-house dispatch creates one task per house with a shared assignment group
- task lifecycle: start → visit → status transitions
- unknown task id returns 404
- report list is conditional (ETag → 304)

## Conventions

- Each test file gets its own server instance on an ephemeral port.
- Data is created with unique names per run (`randomUUID` suffix), so reruns
  against a dirty database still pass. `before` truncates nothing; use the
  `TRUNCATE` snippet above for a clean slate.
- Tests must assert on HTTP status and response body, never on file contents.
  That is what makes them survive a refactor.
