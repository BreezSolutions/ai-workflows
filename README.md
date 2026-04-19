# ai-workflows

Automation surface — Slack bolt bot + scheduled/triggered workflow runs. Split out
from `slack-mcp-bot` so the main app stays focused on conversations + structures.

## What lives here

- **Slack bolt bot** — listens for @mentions / DMs in `src/bot/`, delegates to
  a Claude agent and posts responses back.
- **Workflows** — CRUD + run scheduler + gmail poller + approval queue. See
  `src/api/routes/workflows.ts`, `src/core/runner.ts`, `src/core/scheduler.ts`.
- **Frontend** — Workflow dashboard, editor, detail, approvals (`frontend/src/pages/`).

## What does NOT live here

Conversations, structures, EventChat, knowledge base, cards — all in the core
repo `slack-mcp-bot`. Agent code (`agent.ts`) and action execution (`actions.ts`)
are intentionally *duplicated* in both repos rather than shared via a package.

## Mongo layout

Same cluster, split across two dbs:

- `prod-ai-automation` (this app) — `workflows`, `execution_runs`,
  `execution_items`, `thread_sessions`, `sessions`
- `prod-ai-bot` (core app) — everything else, plus shared `users` /
  `connections` / `settings` that this app reads cross-db for auth + OAuth.

See `src/core/db.ts` for the routing logic and `SHARED_COLLECTIONS` set.

## Migrating from the monolith

One-shot, apps stopped:

```bash
MONGO_URI=<same-as-core> npm run migrate-from-core-db
```

Dry-run first with `DRY_RUN=1`. After a day of the new app running against
the new db, drop the old collections from `prod-ai-bot` manually.

## Dev

```bash
npm install
cd frontend && npm install
cd ..
npm run dev
```
