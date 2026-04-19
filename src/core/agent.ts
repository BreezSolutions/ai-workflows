import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { toolLabel } from "../bot/tools.js";

export interface AgentStep {
  type: "thinking" | "tool_call" | "text";
  data: string;
  ts: number;
}

export interface AgentResult {
  text: string;
  steps: AgentStep[];
  cost_usd: number;
  structuredOutput?: any;
  sessionId?: string;
}

const DEFAULT_TOOLS = [
  "TodoWrite",
  "Agent",
  "WebSearch",
  "WebFetch",
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "AskUserQuestion",
];

const AUTO_APPROVE_TOOLS = new Set([
  "TodoWrite",
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Agent",
]);

// Stall detection — abort if no messages from SDK for this long
const STALL_TIMEOUT_MS = 10 * 60 * 1000;  // 10 min with no messages = stall

export interface PromptImage {
  data: string; // base64-encoded
  media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export interface AgentRunOptions {
  prompt: string;
  images?: PromptImage[];
  model?: string;
  mcpServers?: Record<string, any>;
  allowedTools?: string[];
  systemPrompt?: string;
  effort?: "low" | "medium" | "high" | "max";
  maxTurns?: number;
  sessionId?: string;
  timeoutMs?: number;
  outputFormat?: { type: "json_schema"; schema: Record<string, any> };
  agents?: Record<string, any>; // Named subagent types (SDK agents config)
  abortController?: AbortController; // External abort controller for cancellation
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: any
  ) => Promise<PermissionResult>;
  onToolCall?: (toolName: string, input: Record<string, unknown>) => void;
  onText?: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onSessionId?: (sessionId: string) => void;
}

const MAX_STALL_RETRIES = 2;

/** Build a prompt that may include images as content blocks */
function buildQueryPrompt(text: string, images?: PromptImage[]): string | AsyncIterable<any> {
  if (!images?.length) return text;

  // Build content blocks: text + images
  const content: any[] = [
    { type: "text", text },
    ...images.map(img => ({
      type: "image",
      source: { type: "base64", data: img.data, media_type: img.media_type },
    })),
  ];

  // Return async iterable that yields a single SDKUserMessage
  const message = {
    type: "user" as const,
    message: { role: "user" as const, content },
    parent_tool_use_id: null,
    session_id: "",
  };

  return (async function* () { yield message; })();
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentInnerResult> {
  const mcpToolPatterns = opts.mcpServers
    ? Object.keys(opts.mcpServers).map((name) => `mcp__${name}__*`)
    : [];

  const allowedTools = [...(opts.allowedTools ?? DEFAULT_TOOLS), ...mcpToolPatterns];

  const buildOptions = () => {
    const abortController = new AbortController();
    const options: Record<string, any> = {
      model: opts.model ?? "claude-opus-4-6",
      allowedTools,
      permissionMode: opts.canUseTool ? ("default" as const) : ("dontAsk" as const),
      maxTurns: opts.maxTurns ?? 2000,
      effort: opts.effort ?? "high",
      abortController,
      systemPrompt: opts.systemPrompt
        ? { type: "preset", preset: "claude_code", append: opts.systemPrompt }
        : { type: "preset", preset: "claude_code" },
    };

    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
      options.mcpServers = opts.mcpServers;
    }
    if (opts.agents) {
      options.agents = opts.agents;
    }
    if (opts.canUseTool) {
      options.canUseTool = opts.canUseTool;
    }
    if (opts.sessionId) {
      options.resume = opts.sessionId;
    }
    if (opts.outputFormat) {
      options.outputFormat = opts.outputFormat;
    }
    return { options, abortController };
  };

  for (let attempt = 0; attempt <= MAX_STALL_RETRIES; attempt++) {
    const { options, abortController } = buildOptions();

    // On retry, don't resume stale session
    if (attempt > 0) {
      delete options.resume;
    }

    try {
      const result = await _runAgentInner(opts, options, abortController);

      // If we got a stall (aborted with no result), retry
      if (result.stalled && attempt < MAX_STALL_RETRIES) {
        console.log(`[AGENT] Stall on attempt ${attempt + 1}, retrying...`);
        if (opts.onText) {
          opts.onText("(connection stalled, retrying...)");
        }
        continue;
      }

      return { text: result.text, cost_usd: result.cost_usd, stalled: false, structuredOutput: result.structuredOutput, sessionId: result.sessionId };
    } catch (err: any) {
      if (opts.sessionId && String(err).includes("No conversation found")) {
        console.log("[AGENT] Stale session, retrying without resume");
        continue; // Next attempt won't have resume
      }
      throw err;
    }
  }

  return { text: "(agent failed after retries)", cost_usd: 0, stalled: true };
}

interface AgentInnerResult {
  text: string;
  cost_usd: number;
  stalled: boolean;
  structuredOutput?: any;
  sessionId?: string;
}

async function _runAgentInner(
  opts: AgentRunOptions,
  options: Record<string, any>,
  abortController: AbortController,
): Promise<AgentInnerResult> {
  let resultText = "";
  let costUsd = 0;
  let sessionId: string | undefined;
  let structuredOutput: any = undefined;

  // Stall detector — abort if no messages for STALL_TIMEOUT_MS
  let stallTimer = setTimeout(() => {
    console.warn(`[AGENT] Stall detected (${STALL_TIMEOUT_MS / 1000}s no messages) — aborting`);
    abortController.abort();
  }, STALL_TIMEOUT_MS);

  const resetStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      console.warn(`[AGENT] Stall detected (${STALL_TIMEOUT_MS / 1000}s no messages) — aborting`);
      abortController.abort();
    }, STALL_TIMEOUT_MS);
  };

  try {
    for await (const message of query({ prompt: buildQueryPrompt(opts.prompt, opts.images), options })) {
      resetStall(); // Got a message, reset stall timer
      const msg = message as any;

      // Capture session ID from init message
      if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id ?? msg.data?.session_id ?? msg.data?.sessionId;
        if (sessionId && opts.onSessionId) {
          opts.onSessionId(sessionId);
        }
      }

      // Detect tool calls from assistant messages
      if (msg.type === "assistant") {
        const content = msg.message?.content ?? msg.content;
        if (content && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use" && opts.onToolCall) {
              opts.onToolCall(block.name, block.input ?? {});
            }
            if (block.type === "text" && block.text && opts.onText) {
              opts.onText(block.text);
            }
            if (block.type === "thinking" && block.thinking && opts.onThinking) {
              opts.onThinking(block.thinking);
            }
          }
        }
      }

      // Capture result
      if (msg.type === "result") {
        resultText = msg.result ?? "(no response)";
        costUsd = msg.total_cost_usd ?? msg.cost_usd ?? 0;
        if (msg.structured_output) {
          structuredOutput = msg.structured_output;
        }
      }
    }
  } catch (err: any) {
    if (err.name === "AbortError" || String(err).includes("abort")) {
      console.warn("[AGENT] Aborted — stall detected");
      return { text: resultText || "", cost_usd: costUsd, stalled: true, sessionId };
    }
    console.error("[AGENT] Error:", err.message || err);
    if (err.stderr) console.error("[AGENT] stderr:", err.stderr);
    if (err.stdout) console.error("[AGENT] stdout:", err.stdout);
    throw err;
  } finally {
    clearTimeout(stallTimer);
  }

  return { text: resultText || "(no response)", cost_usd: costUsd, stalled: false, structuredOutput, sessionId };
}

export interface StreamEvent {
  type: "session_id" | "tool_call" | "tool_result" | "thinking" | "text" | "done" | "error" | "cost" | "permission_request";
  data: any;
}

export async function* streamAgent(opts: AgentRunOptions): AsyncGenerator<StreamEvent> {
  const mcpToolPatterns = opts.mcpServers
    ? Object.keys(opts.mcpServers).map((name) => `mcp__${name}__*`)
    : [];

  const allowedTools = [...(opts.allowedTools ?? DEFAULT_TOOLS), ...mcpToolPatterns];
  const abortController = opts.abortController ?? new AbortController();

  const options: Record<string, any> = {
    model: opts.model ?? "claude-opus-4-6",
    allowedTools,
    permissionMode: opts.canUseTool ? ("default" as const) : ("dontAsk" as const),
    ...(opts.canUseTool ? { canUseTool: opts.canUseTool } : {}),
    maxTurns: opts.maxTurns ?? 2000,
    effort: opts.effort ?? "high",
    abortController,
    systemPrompt: opts.systemPrompt
      ? { type: "preset", preset: "claude_code", append: opts.systemPrompt }
      : { type: "preset", preset: "claude_code" },
  };

  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    options.mcpServers = opts.mcpServers;
  }
  if (opts.agents) {
    options.agents = opts.agents;
  }
  if (opts.sessionId) {
    options.resume = opts.sessionId;
  }

  try {
    yield* _streamAgentInner(opts, options, abortController);
  } catch (err: any) {
    if (opts.sessionId && String(err).includes("No conversation found")) {
      console.log("[STREAM] Stale session, retrying without resume");
      delete options.resume;
      const newAbort = new AbortController();
      options.abortController = newAbort;
      yield* _streamAgentInner(opts, options, newAbort);
    } else {
      throw err;
    }
  }
}

async function* _streamAgentInner(
  opts: AgentRunOptions,
  options: Record<string, any>,
  abortController: AbortController,
): AsyncGenerator<StreamEvent> {
  let resultText = "";

  let stallTimer = setTimeout(() => {
    console.warn(`[STREAM] Stall detected — aborting`);
    abortController.abort();
  }, STALL_TIMEOUT_MS);

  const resetStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      console.warn(`[STREAM] Stall detected — aborting`);
      abortController.abort();
    }, STALL_TIMEOUT_MS);
  };

  try {
    for await (const message of query({ prompt: buildQueryPrompt(opts.prompt, opts.images), options })) {
      resetStall();
      const msg = message as any;

      // Debug: log ALL system subtypes to find task completion events
      if (msg.type === "system") {
        console.log(`[STREAM-DEBUG] system/${msg.subtype} keys=${Object.keys(msg).join(",")}`);
        if (msg.subtype?.includes("task")) {
          console.log(`[STREAM-DEBUG] TASK-EVENT: ${JSON.stringify(msg).slice(0, 800)}`);
        }
      }

      if (msg.type === "system" && msg.subtype === "init") {
        const sid = msg.session_id ?? msg.data?.session_id ?? msg.data?.sessionId;
        if (sid) yield { type: "session_id", data: sid };
      }

      if (msg.type === "assistant") {
        const content = msg.message?.content ?? msg.content;
        if (content && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use") {
              // Deep-clone input so downstream consumers see a stable snapshot
              // regardless of what the SDK does with the reference afterward.
              const inputSnapshot = block.input ? JSON.parse(JSON.stringify(block.input)) : {};
              yield { type: "tool_call", data: { name: block.name, input: inputSnapshot } };
            } else if (block.type === "thinking" && block.thinking) {
              yield { type: "thinking", data: block.thinking };
            } else if (block.type === "text" && block.text) {
              yield { type: "text", data: block.text };
            }
          }
        }
      }

      if (msg.type === "user") {
        const content = msg.message?.content ?? msg.content;
        if (content && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              yield { type: "tool_result", data: { content: block.content } };
            }
          }
        }
      }

      // Subagent lifecycle events
      if (msg.type === "system" && msg.subtype === "task_started") {
        yield { type: "tool_call", data: { name: "Subagent", input: { description: msg.description, task_id: msg.task_id } } };
      }
      if (msg.type === "system" && msg.subtype === "task_progress") {
        if (msg.last_tool_name) {
          yield { type: "tool_call", data: { name: `subagent:${msg.last_tool_name}`, input: {} } };
        }
      }
      if (msg.type === "system" && msg.subtype === "task_notification" && msg.status === "completed") {
        // summary contains the subagent's output, output_file has the full result
        const summary = msg.summary ?? "";
        if (summary) {
          yield { type: "tool_result", data: { content: summary } };
        }
      }

      if (msg.type === "result") {
        resultText = msg.result ?? "";
        const costUsd = msg.total_cost_usd ?? msg.cost_usd ?? 0;
        if (costUsd > 0) {
          yield { type: "cost", data: `$${costUsd.toFixed(4)}` };
        }
      }
    }
  } catch (err: any) {
    if (err.name === "AbortError" || String(err).includes("abort")) {
      console.warn("[STREAM] Aborted — yielding error event");
      yield { type: "error", data: "Agent timed out" };
    } else {
      throw err;
    }
  } finally {
    clearTimeout(stallTimer);
  }

  yield { type: "done", data: resultText || "(no response)" };
}

export async function runAgentHeadless(opts: {
  prompt: string;
  model?: string;
  mcpServers?: Record<string, any>;
  systemPrompt?: string;
  effort?: "low" | "medium" | "high" | "max";
  maxTurns?: number;
  sessionId?: string;
  outputFormat?: { type: "json_schema"; schema: Record<string, any> };
  onStep?: (step: AgentStep) => void;
}): Promise<AgentResult> {
  const steps: AgentStep[] = [];
  let sessionId: string | undefined;
  const result = await runAgent({
    ...opts,
    canUseTool: async () => ({ behavior: "allow" as const }),
    onToolCall: (name, input) => {
      const label = toolLabel(name, input);
      console.log(`[AGENT] tool: ${label}`);
      const step: AgentStep = { type: "tool_call", data: label, ts: Date.now() };
      steps.push(step);
      opts.onStep?.(step);
    },
    onText: (t) => {
      const step: AgentStep = { type: "text", data: t, ts: Date.now() };
      steps.push(step);
      opts.onStep?.(step);
    },
    onThinking: (t) => {
      const step: AgentStep = { type: "thinking", data: t, ts: Date.now() };
      steps.push(step);
      opts.onStep?.(step);
    },
    onSessionId: (sid) => {
      sessionId = sid;
    },
  });
  return { text: result.text, steps, cost_usd: result.cost_usd, structuredOutput: result.structuredOutput, sessionId };
}
