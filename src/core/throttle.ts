// Lightweight rate limiters for user-facing Slack/Gmail API calls.

const SLACK_MIN_INTERVAL = 100;
const GMAIL_MIN_INTERVAL = 50;

let lastSlackCall = 0;
let lastGmailCall = 0;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function slackThrottle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, SLACK_MIN_INTERVAL - (now - lastSlackCall));
  if (wait > 0) await delay(wait);
  lastSlackCall = Date.now();
}

export async function gmailThrottle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, GMAIL_MIN_INTERVAL - (now - lastGmailCall));
  if (wait > 0) await delay(wait);
  lastGmailCall = Date.now();
}
