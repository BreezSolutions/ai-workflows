# Local Development Guide

## Prerequisites

- Node.js 20+
- npm
- [ngrok](https://ngrok.com/) (for Slack OAuth + Events API callbacks)
- Access to the Slack app at https://api.slack.com/apps

## Quick Start

```bash
# Install dependencies
npm install
cd frontend && npm install && cd ..

# Start ngrok (keep this running in a separate terminal)
ngrok http 8080

# Copy the ngrok URL (e.g. https://xxxx.ngrok-free.dev)
# Update APP_URL in .env to match

# Start dev servers (API on :8080, frontend on :5173)
npm run dev
```

This runs the API (with hot-reload via `tsx watch`) and the Vite frontend concurrently.

Open http://localhost:5173 in your browser.

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|----------|-------------|
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-...`) for Socket Mode |
| `SLACK_BOT_TOKEN` | Bot OAuth token (`xoxb-...`) for the MathDash workspace |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | For Slack OAuth (user token flow) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `CLAUDE_MODEL` | Model to use (e.g. `claude-opus-4-6`) |
| `MONGO_URI` / `MONGO_DB` | MongoDB Atlas connection |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail OAuth credentials |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_BUCKET_NAME` / `AWS_REGION` | S3 for file storage |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_AUTH_TOKEN` | Supabase (Nowadays DB, read-only) |
| `REDUCTO_API_KEY` | Document parsing service |
| `APP_URL` | **Your ngrok URL** — required for OAuth redirects and Slack Events API |
| `MCP_SERVERS` | JSON map of MCP server configs |

## ngrok Setup

ngrok provides a public URL that tunnels to your local server. Required because:

1. **Slack OAuth** redirects back to `APP_URL/api/connections/slack/callback`
2. **Slack Events API** posts events to `APP_URL/slack/events`
3. **Gmail OAuth** redirects back to `APP_URL/api/connections/gmail/callback`

```bash
ngrok http 8080
```

After starting ngrok, update `APP_URL` in `.env` to the forwarding URL (e.g. `https://xxxx.ngrok-free.dev`). You need to restart the dev server after changing `.env`.

> **Tip:** Use a stable ngrok domain (`ngrok http --domain=your-domain.ngrok-free.dev 8080`) to avoid updating the URL every time.

## Slack App Configuration

### OAuth Redirect URL

In your Slack app settings → **OAuth & Permissions** → **Redirect URLs**, add:
```
https://YOUR-NGROK-URL/api/connections/slack/callback
```

### Events API (User-Scoped, Real-Time)

This is how folders get real-time Slack messages for pinned channels — including channels across workspaces (e.g. Nowadays workspace channels via a user token).

1. Go to **Event Subscriptions** → Enable Events
2. Set **Request URL** to:
   ```
   https://YOUR-NGROK-URL/slack/events
   ```
   Slack will send a verification challenge — the server handles this automatically.
3. Under **Subscribe to events on behalf of users**, add:
   - `message.channels` — messages in public channels
   - `message.groups` — messages in private channels
   - `message.im` — direct messages
   - `message.mpim` — group DMs (optional)
4. Reinstall the app after changing event subscriptions

### Multi-Workspace Context

- **Bot token** (`xoxb-...`): Only sees the workspace where the app is installed (MathDash)
- **User token** (via OAuth): Sees channels the authorized user is in, even across workspaces
- To watch Nowadays workspace channels, a user with access to those channels needs to authorize via the Connections page in the UI

## Optional Feature Flags

By default in local dev, background services are disabled to avoid interference. Enable them with env vars:

| Flag | What it enables |
|------|----------------|
| `ENABLE_SLACK_BOT=true` | Slack Socket Mode bot (responds to @mentions and DMs) |
| `ENABLE_SCHEDULER=true` | Cron-based workflow scheduler |
| `ENABLE_GMAIL_POLLER=true` | Gmail polling for workflow triggers |
| `ENABLE_FOLDER_WATCHER=true` | Email thread polling for folder pins (every 15 min) |

Slack real-time events (via Events API) work regardless of these flags — they come in through the HTTP endpoint, not Socket Mode.

## Architecture

```
src/
├── index.ts              # Entry point — starts API, optional bot/scheduler/watchers
├── api/
│   ├── app.ts            # Express app — all routes + Slack Events API endpoint
│   └── routes/           # Route handlers (workflows, executions, folders, etc.)
├── bot/
│   └── slack.ts          # Slack Socket Mode bot
├── core/
│   ├── db.ts             # MongoDB collections and helpers
│   ├── runner.ts         # Workflow execution engine
│   ├── scheduler.ts      # Cron-based workflow triggers
│   ├── folder-watcher.ts # Real-time Slack + email polling for folders
│   ├── gmail-poller.ts   # Gmail polling for workflow triggers
│   ├── s3.ts             # AWS S3 file upload/presigned URLs
│   ├── reducto.ts        # Document parsing via Reducto API
│   └── events.ts         # Event bus (Socket.IO bridge)
frontend/
├── src/
│   ├── pages/            # Main UI pages (Workflows, Folders, Approvals, etc.)
│   └── api.ts            # Frontend API client
```

## Common Tasks

**Reset stuck runs:** If the server crashes mid-execution, runs may be stuck in "running" status. The server auto-cleans these on startup (`cleanupStaleRuns`), or restart the dev server.

**Test a workflow manually:** Use the UI's "Test" button, or:
```bash
curl -X POST http://localhost:8080/api/workflows/WORKFLOW_ID/test
```

**Check Slack Events API is working:** After setting the Request URL, send a message in a channel that's pinned in a folder. You should see `[FOLDER-WATCHER] Injected Slack message...` in the server logs.
