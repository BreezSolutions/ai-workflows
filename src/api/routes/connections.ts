import { Router } from "express";
import * as db from "../../core/db.js";

const router = Router();

// List all connections
router.get("/", async (req, res) => {
  try {
    const userId = (req as any).userId;
    const connections = await db.listConnections(userId);
    // Strip credentials from response
    const safe = connections.map(({ credentials, ...rest }) => {
      // Expose granted OAuth scopes (Google stores them space-delimited in credentials.scope).
      const rawScope = (credentials as any)?.scope;
      const scopes = typeof rawScope === "string" ? rawScope.split(/\s+/).filter(Boolean) : undefined;
      return { ...rest, connected: true, scopes };
    });
    res.json(safe);
  } catch (err) {
    console.error("Error listing connections:", err);
    res.status(500).json({ error: "Failed to list connections" });
  }
});

// Delete a connection
router.delete("/:service", async (req, res) => {
  try {
    const userId = (req as any).userId;
    await db.deleteConnection(req.params.service, userId);
    res.status(204).end();
  } catch (err) {
    console.error("Error deleting connection:", err);
    res.status(500).json({ error: "Failed to delete connection" });
  }
});

// --- Gmail OAuth ---

router.get("/gmail/auth-url", (_req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(400).json({ error: "GOOGLE_CLIENT_ID not configured" });

  const redirectUri = `${process.env.APP_URL || "http://localhost:8080"}/api/connections/gmail/callback`;
  const scopes = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/drive.readonly",
  ];

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");

  res.json({ url: url.toString() });
});

router.get("/gmail/callback", async (req, res) => {
  const code = req.query.code as string;
  if (!code) return res.status(400).send("Missing authorization code");

  try {
    const { google } = await import("googleapis");
    const baseUrl = process.env.NODE_ENV === "production"
      ? (process.env.APP_URL || "http://localhost:8080")
      : "http://localhost:5173";
    const redirectUri = `${baseUrl}/api/connections/gmail/callback`;
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      redirectUri
    );

    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);

    // Get user profile for login
    const oauth2 = google.oauth2({ version: "v2", auth });
    const profile = await oauth2.userinfo.get();
    const email = profile.data.email!;
    const name = profile.data.name || email;
    const picture = profile.data.picture || undefined;

    // Find or create user
    const user = await db.findOrCreateUser(email, name, picture);

    // Store Gmail credentials as this user's connection
    await db.upsertConnection("gmail", {
      service: "gmail",
      email,
      credentials: tokens as Record<string, any>,
      user_id: user.id,
    } as any);

    // If this is ina@nowadays.ai, claim all unowned data
    if (email === "ina@nowadays.ai") {
      const claimed = await db.claimUnownedData(user.id);
      if (claimed > 0) console.log(`[AUTH] Claimed ${claimed} unowned records for ${email}`);
    }

    // Set session
    (req.session as any).userId = user.id;

    res.redirect("/?logged_in=true");
  } catch (err) {
    console.error("Gmail OAuth error:", err);
    res.redirect("/login?error=auth_failed");
  }
});

// --- Slack User OAuth ---

router.get("/slack/auth-url", (_req, res) => {
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) return res.status(400).json({ error: "SLACK_CLIENT_ID not configured" });

  const redirectUri = `${process.env.APP_URL || "http://localhost:8080"}/api/connections/slack/callback`;
  const scopes = [
    "channels:read",
    "channels:history",
    "groups:read",
    "groups:history",
    "im:history",
    "chat:write",
    "users:read",
    "files:read",
  ];

  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("user_scope", scopes.join(","));

  res.json({ url: url.toString() });
});

router.get("/slack/callback", async (req, res) => {
  const code = req.query.code as string;
  if (!code) return res.status(400).send("Missing authorization code");

  try {
    const redirectUri = `${process.env.APP_URL || "http://localhost:8080"}/api/connections/slack/callback`;
    const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID!,
        client_secret: process.env.SLACK_CLIENT_SECRET!,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const data = await tokenRes.json() as any;
    if (!data.ok) throw new Error(`Slack OAuth error: ${data.error}`);

    const userToken = data.authed_user?.access_token;
    const userId = data.authed_user?.id;
    if (!userToken) throw new Error("No user token returned");

    // Get user info for display
    const userRes = await fetch("https://slack.com/api/users.info?user=" + userId, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    const userData = await userRes.json() as any;
    const displayName = userData.user?.real_name || userData.user?.name || userId;

    const appUserId = (req.session as any)?.userId;
    await db.upsertConnection("slack", {
      service: "slack",
      email: displayName,
      credentials: {
        user_token: userToken,
        user_id: userId,
        team_id: data.team?.id,
      },
      user_id: appUserId,
    } as any);

    res.redirect("/connections?connected=slack");
  } catch (err) {
    console.error("Slack OAuth error:", err);
    res.redirect("/connections?error=slack_auth_failed");
  }
});

// Get Slack team ID for constructing deep links
router.get("/slack/team", async (_req, res) => {
  try {
    const conn = await db.getConnection("slack");
    if (!conn) return res.status(404).json({ error: "No Slack connection" });
    const teamId = conn.credentials?.team_id;
    if (!teamId) return res.status(404).json({ error: "No team_id stored" });
    res.json({ team_id: teamId });
  } catch (err) {
    console.error("Error fetching Slack team:", err);
    res.status(500).json({ error: "Failed to fetch Slack team" });
  }
});

// ── Supabase connection (URL + API key, no OAuth) ───────────────────

router.post("/supabase/connect", async (req, res) => {
  try {
    const { url, api_key, auth_token, schema } = req.body;
    if (!url || !api_key) return res.status(400).json({ error: "url and api_key (anon key) are required" });

    // Verify the connection works
    const authHeader = auth_token || api_key;
    try {
      const testResp = await fetch(`${url}/rest/v1/?limit=0`, {
        headers: { apikey: api_key, Authorization: `Bearer ${authHeader}` },
      });
      if (!testResp.ok && testResp.status !== 401 && testResp.status !== 403) {
        return res.status(400).json({ error: `Failed to connect to Supabase (${testResp.status}). Check URL and keys.` });
      }
    } catch (fetchErr: any) {
      return res.status(400).json({ error: `Cannot reach Supabase: ${fetchErr.message}` });
    }

    const appUserId = (req.session as any)?.userId;
    await db.upsertConnection("supabase", {
      service: "supabase",
      email: new URL(url).hostname,
      credentials: { url, api_key, auth_token: auth_token || api_key, schema: schema || "public" },
      user_id: appUserId,
    } as any);
    res.json({ ok: true });
  } catch (err) {
    console.error("Supabase connection error:", err);
    res.status(500).json({ error: "Failed to connect to Supabase" });
  }
});

export default router;
