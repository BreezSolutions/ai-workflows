import { Router } from "express";
import * as db from "../../core/db.js";

const router = Router();

// Google OAuth: generate auth URL
router.get("/google-url", (_req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(400).json({ error: "GOOGLE_CLIENT_ID not configured" });

  // In dev, use frontend port so cookies are set on the right origin via Vite proxy
  const baseUrl = process.env.NODE_ENV === "production"
    ? (process.env.APP_URL || "http://localhost:8080")
    : "http://localhost:5173";
  const redirectUri = `${baseUrl}/api/connections/gmail/callback`;
  const scopes = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.readonly",
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

// Google OAuth callback is handled by /api/connections/gmail/callback (already registered in Google Console)

// Get current user
router.get("/me", async (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const user = await db.getUser(userId);
  if (!user) return res.status(401).json({ error: "User not found" });
  res.json(user);
});

// Logout
router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("Session destroy error:", err);
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

export default router;
