import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { runAgent } from "../core/agent.js";
import { ProgressTracker } from "./progress.js";
import { toolLabel } from "./tools.js";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import * as db from "../core/db.js";
import { runWorkflow } from "../core/runner.js";

const APPROVAL_TIMEOUT = 120_000;

const AUTO_APPROVE_TOOLS = new Set([
  "TodoWrite",
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Agent",
  "Bash",
  "Write",
  "Edit",
]);

// Pending approvals: message_ts -> { resolve }
const pendingApprovals = new Map<
  string,
  { resolve: (approved: boolean) => void }
>();

function loadMcpServersWithConversation(): Record<string, any> {
  const raw = process.env.MCP_SERVERS ?? "";
  let servers: Record<string, any> = {};
  try { servers = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
  // Add conversation-cli as an MCP server (native tools for email, Slack, calendar, Supabase)
  if (!servers.conversation) {
    servers.conversation = { command: "node", args: [`${process.cwd()}/scripts/conversation-mcp-server.mjs`] };
  }
  return servers;
}

const SLACK_FORMATTING = `

You are responding in Slack. Use Slack mrkdwn formatting, NOT standard markdown:
- Bold: *text* (single asterisks, NOT **double**)
- Italic: _text_
- Strikethrough: ~text~
- Code: \`code\` or \`\`\`code block\`\`\`
- Links: <url|text> (NOT [text](url))
- Lists: use bullet • or dash - (both work)
- NO ## headers (use *bold text* on its own line instead)
- NO markdown tables (use spaced columns or bullet lists instead)
- Emojis: use :emoji_name: syntax (e.g. :warning: :white_check_mark: :rotating_light:)

IMPORTANT — File sharing: When the user asks you to share/attach a file, you MUST upload it directly to the Slack thread as an attachment — do NOT just paste a download link. The user expects to see the file appear in Slack, not a URL.
To upload a file to the current thread:
1. Get the file URL (e.g. from attachment_download which returns a download URL, or any other URL)
2. Upload it using Bash: curl -s -X POST http://localhost:${process.env.PORT || 3000}/api/slack/upload -H "Content-Type: application/json" -d '{"file_url":"THE_URL","channel":"CHANNEL","thread_ts":"THREAD_TS","filename":"name.pdf","comment":"optional message"}'
   Or from a local file: -d '{"file_path":"/tmp/file.pdf","channel":"CHANNEL","thread_ts":"THREAD_TS"}'
Use the channel and thread_ts from "Current Slack context" below. Always upload — never just share raw URLs.
`;

function describeFiles(files: any[] | undefined): string {
  if (!files?.length) return "";
  const port = process.env.PORT || 3000;
  const items = files.map((f: any) => {
    const name = f.name || f.title || "file";
    return `- "${name}" (${f.mimetype || "unknown type"}, id: ${f.id}) -> download: curl -s http://localhost:${port}/api/slack/files/${f.id}/download -o /tmp/${name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  }).join("\n");
  return `\n\nThe user attached ${files.length} file(s) to this message:\n${items}\nIMPORTANT: Download these files using the curl commands above, then read/parse them to answer the user's question. For images, download to /tmp/ and then use your Read tool to view the image file.`;
}

async function requestApproval(
  webClient: WebClient,
  channel: string,
  threadTs: string,
  toolName: string,
  inputData: Record<string, unknown>,
): Promise<boolean> {
  let detail: string;
  if (toolName === "Bash") {
    detail = "```" + (inputData.command ?? "") + "```";
  } else if (toolName === "Write" || toolName === "Edit") {
    detail = "`" + (inputData.file_path ?? "unknown") + "`";
  } else {
    detail = "```" + JSON.stringify(inputData, null, 2).slice(0, 500) + "```";
  }

  const msg = await webClient.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `*Permission requested:* \`${toolName}\`\n${detail}\n\nReact with :white_check_mark: to approve or :x: to deny.`,
  });

  const msgTs = msg.ts!;

  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(msgTs, { resolve });

    const timeout = setTimeout(() => {
      pendingApprovals.delete(msgTs);
      webClient.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Permission request for \`${toolName}\` timed out — denying.`,
      });
      resolve(false);
    }, APPROVAL_TIMEOUT);

    // Wrap resolve to clear timeout
    const originalResolve = resolve;
    pendingApprovals.set(msgTs, {
      resolve: (approved: boolean) => {
        clearTimeout(timeout);
        pendingApprovals.delete(msgTs);
        originalResolve(approved);
      },
    });
  });
}

async function handleMessage(
  webClient: WebClient,
  channel: string,
  threadTs: string,
  text: string,
  say: (args: any) => Promise<any>,
  mcpServers: Record<string, any>,
  model: string,
  isThreadReply = false,
): Promise<void> {
  if (!text) {
    await say({ text: "How can I help?", channel, thread_ts: threadTs });
    return;
  }

  const systemPrompt = (await db.getSetting("system_prompt")) ?? process.env.SYSTEM_PROMPT ?? "";
  const existingSession = await db.getThreadSession(threadTs);

  // Tell the agent its current Slack context (channel + thread)
  let threadContext = `\n\nCurrent Slack context: channel=${channel} thread_ts=${threadTs}`;
  if (!existingSession && isThreadReply) {
    threadContext += `\nYou were just @mentioned in a Slack thread. This is your first message in this thread, so you don't have prior context. If the user's message seems to reference earlier conversation, use the Slack MCP tool to read this thread for context.`;
  }

  const progress = new ProgressTracker(webClient, channel, threadTs);
  await progress.start();

  try {
    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      _options: any,
    ): Promise<PermissionResult> => {
      if (AUTO_APPROVE_TOOLS.has(toolName) || toolName.startsWith("mcp__")) {
        return { behavior: "allow" as const, updatedInput: input };
      }
      const approved = await requestApproval(
        webClient,
        channel,
        threadTs,
        toolName,
        input,
      );
      if (approved) {
        return { behavior: "allow" as const, updatedInput: input };
      }
      return {
        behavior: "deny" as const,
        message: "User denied this action in Slack",
      };
    };

    const agentOpts = {
      prompt: text,
      model,
      mcpServers,
      systemPrompt: (systemPrompt || "") + SLACK_FORMATTING + threadContext,
      canUseTool,
      sessionId: existingSession ?? undefined,
      onSessionId: (sid: string) => {
        db.setThreadSession(threadTs, sid).catch(console.error);
      },
      onToolCall: (name: string, input: Record<string, unknown>) => {
        const step = toolLabel(name, input);
        console.log(`[SLACK] onToolCall fired: ${name} -> "${step}"`);
        progress.addStep(step);
      },
      onText: (text: string) => {
        const short = text.length > 200 ? text.slice(0, 200) + "..." : text;
        console.log(`[SLACK] onText: "${short}"`);
        progress.addStep(`_${short}_`);
      },
    };

    const response = await runAgent(agentOpts);
    const responseText = response.text;

    await progress.finish();

    // Split long messages (Slack 4000 char limit)
    for (let i = 0; i < responseText.length; i += 3900) {
      await say({
        text: responseText.slice(i, i + 3900),
        channel,
        thread_ts: threadTs,
      });
    }
  } catch (err) {
    await progress.finish();
    const errorMsg = String(err);
    if (errorMsg.includes("Stream closed") || errorMsg.includes("BrokenPipe")) {
      await say({
        text: ":warning: The agent process died unexpectedly. This can happen if it ran out of memory or the MCP server disconnected. Please try again.",
        channel,
        thread_ts: threadTs,
      });
    } else {
      console.error("Error running agent:", err);
      await say({
        text: `Sorry, something went wrong: ${err}`,
        channel,
        thread_ts: threadTs,
      });
    }
  }
}

export async function startSlackBot(): Promise<void> {
  const mcpServers = loadMcpServersWithConversation();
  const model = "claude-opus-4-6";

  if (Object.keys(mcpServers).length > 0) {
    console.log("MCP servers configured:", Object.keys(mcpServers));
  }

  const app = new App({
    token: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    socketMode: true,
  });

  let botUserId: string | null = null;
  async function getBotId(): Promise<string> {
    if (!botUserId) {
      const auth = await app.client.auth.test();
      botUserId = auth.user_id as string;
    }
    return botUserId;
  }

  // Handle approval reactions
  app.event("reaction_added", async ({ event }) => {
    const msgTs = (event as any).item?.ts;
    const reaction = (event as any).reaction ?? "";
    const pending = pendingApprovals.get(msgTs);
    if (!pending) return;

    if (
      ["white_check_mark", "heavy_check_mark", "+1", "thumbsup"].includes(
        reaction,
      )
    ) {
      pending.resolve(true);
    } else if (["x", "no_entry_sign", "-1", "thumbsdown"].includes(reaction)) {
      pending.resolve(false);
    }
  });

  // Handle @mentions
  app.event("app_mention", async ({ event, say }) => {
    const bid = await getBotId();
    const text = (event.text ?? "").replace(`<@${bid}>`, "").trim();
    const filesNote = describeFiles((event as any).files);
    const isThreadReply = !!(event as any).thread_ts;
    const threadTs = (event as any).thread_ts ?? event.ts;
    await handleMessage(
      app.client,
      event.channel,
      threadTs,
      text + filesNote,
      say,
      mcpServers,
      model,
      isThreadReply,
    );
  });

  // Handle DMs
  app.event("message", async ({ message, say }) => {
    const msg = message as any;
    if (msg.channel_type !== "im") return;
    // Allow file_share subtype through, skip other subtypes
    if (msg.subtype && msg.subtype !== "file_share") return;
    const bid = await getBotId();
    if (msg.user === bid) return;

    const text = (msg.text ?? "").trim();
    const filesNote = describeFiles(msg.files);
    const isThreadReply = !!msg.thread_ts;
    const threadTs = msg.thread_ts ?? msg.ts;
    if (!text && !filesNote) return;

    await handleMessage(
      app.client,
      msg.channel,
      threadTs,
      (text || "The user sent files:") + filesNote,
      say,
      mcpServers,
      model,
      isThreadReply,
    );
  });

  // Check incoming channel messages against slack_message workflow triggers
  app.event("message", async ({ message }) => {
    const msg = message as any;
    console.log(`[SLACK] message event: channel=${msg.channel} type=${msg.channel_type} subtype=${msg.subtype} hasText=${!!msg.text}`);
    // Skip DMs (handled above), bot messages, and subtypes
    if (msg.channel_type === "im" || msg.subtype || !msg.text) return;

    try {
      const workflows = await db.getWorkflowsByTrigger("slack_message");
      console.log(`[SLACK] Found ${workflows.length} slack_message workflow(s), checking channel ${msg.channel}`);
      for (const workflow of workflows) {
        const channels: string[] =
          workflow.trigger_config.channels ??
          (workflow.trigger_config.channel
            ? [workflow.trigger_config.channel]
            : []);
        const matchesAny = channels.length === 0 || channels.includes("*");
        if (!matchesAny && !channels.includes(msg.channel)) continue;

        console.log(`Slack message triggered workflow: ${workflow.name}`);
        const run = await db.createRun(workflow.id, "slack_message");
        const triggerData = {
          trigger: "slack_message",
          channel: msg.channel,
          user: msg.user,
          text: msg.text,
          ts: msg.ts,
          thread_ts: msg.thread_ts,
        };
        runWorkflow(workflow, run, triggerData).catch((err) =>
          console.error(
            `Workflow ${workflow.id} failed from Slack trigger:`,
            err,
          ),
        );
      }
    } catch (err) {
      console.error("Error checking slack_message triggers:", err);
    }
  });

  // App home
  app.event("app_home_opened", async ({ event }) => {
    const mcpText =
      Object.keys(mcpServers).length > 0
        ? Object.keys(mcpServers)
            .map((n) => `• *${n}*`)
            .join("\n")
        : "None configured";

    await app.client.views.publish({
      user_id: event.user,
      view: {
        type: "home",
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: "Claude Agent Bot" },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "I'm an AI assistant powered by Claude Agent SDK. Send me a DM or @mention me in a channel.",
            },
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: `*MCP Servers:*\n${mcpText}` },
          },
        ],
      },
    });
  });

  await app.start();
  console.log("Slack bot is running!");
}
