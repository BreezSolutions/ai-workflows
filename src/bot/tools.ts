const TOOL_LABELS: Record<string, string> = {
  Read: "Reading file",
  Write: "Writing file",
  Edit: "Editing file",
  Bash: "Running command",
  Glob: "Searching for files",
  Grep: "Searching file contents",
  WebSearch: "Searching the web",
  WebFetch: "Fetching web page",
  Agent: "Spawning subagent",
  Task: "Spawning subagent",
  TodoWrite: "Updating tasks",
  AskUserQuestion: "Asking a question",
};

function summarizeInput(input: Record<string, unknown>, maxLen = 60): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(input)) {
    if (typeof val === "string" && val) {
      const short = val.length > maxLen ? val.slice(0, maxLen) + "..." : val;
      parts.push(`${key}=\`${short}\``);
    }
  }
  return parts.join(", ");
}

export function toolLabel(toolName: string, input?: Record<string, unknown>): string {
  if (toolName.startsWith("mcp__")) {
    // Parse structure MCP tool into readable labels
    if (toolName === "mcp__structure__run" && input?.args) {
      const sArgs = String(input.args).trim();

      if (/^commands\b/.test(sArgs)) return "View available commands";
      if (/^attach\b/.test(sArgs)) {
        const file = sArgs.match(/attach\s+\S+\s+(.+)/)?.[1]?.split("/").pop();
        return file ? `Upload file: "${file}"` : "Upload file";
      }

      const startMatch = sArgs.match(/^(\S+)\s+start\s+\S+\s*(.*)/);
      if (startMatch) {
        const cmdName = startMatch[1].replace(/-/g, " ");
        const ids = startMatch[2]?.trim();
        return ids ? `Start ${cmdName} (${ids})` : `View ${cmdName} fields`;
      }

      const updateMatch = sArgs.match(/^(\S+)\s+update\s+\S+\s+\S+\s*(.*)/);
      if (updateMatch) {
        const cmdName = updateMatch[1].replace(/-/g, " ");
        const flagsStr = updateMatch[2] || "";
        const fields: string[] = [];
        const flagRe = /--(\S+)\s+"([^"]+)"|--(\S+)\s+(\S+)/g;
        let m;
        while ((m = flagRe.exec(flagsStr))) fields.push(m[1] || m[3]);
        const detail = fields.length > 0 ? `: ${fields.join(", ")}` : "";
        return `Update ${cmdName}${detail}`;
      }

      if (/^\S+\s+submit\b/.test(sArgs)) {
        const cmdName = sArgs.match(/^(\S+)/)?.[1]?.replace(/-/g, " ") ?? "";
        return `Submit ${cmdName}`;
      }
      if (/^\S+\s+list\b/.test(sArgs)) return `List ${sArgs.match(/^(\S+)/)?.[1]?.replace(/-/g, " ")} entries`;
      if (/^\S+\s+get\b/.test(sArgs)) return `View ${sArgs.match(/^(\S+)/)?.[1]?.replace(/-/g, " ")} entry`;
      if (/^\S+\s+delete\b/.test(sArgs)) return `Delete ${sArgs.match(/^(\S+)/)?.[1]?.replace(/-/g, " ")} entry`;

      return `Structure: ${sArgs.length > 60 ? sArgs.slice(0, 60) + "..." : sArgs}`;
    }

    const parts = toolName.split("__");
    const server = parts[1] ?? "mcp";
    const fn = parts[2] ?? "tool";
    const detail = input ? summarizeInput(input) : "";
    const base = `${server} → ${fn}`;
    return detail ? `${base}  (${detail})` : base;
  }

  const label = TOOL_LABELS[toolName] ?? toolName;
  if (!input) return label;

  if (toolName === "Bash") {
    const cmd = input.command;
    if (typeof cmd === "string" && cmd) {
      // Parse structure-cli commands into readable labels
      const structMatch = cmd.match(/structure-cli\.mjs\s+(.+)$/);
      if (structMatch) {
        const sArgs = structMatch[1].trim();

        if (/^commands\b/.test(sArgs)) return "View available commands";

        if (/^attach\b/.test(sArgs)) {
          const file = sArgs.match(/attach\s+\S+\s+(.+)/)?.[1]?.split("/").pop();
          return file ? `Upload file: "${file}"` : "Upload file";
        }

        // <command> start <chatId> <ids>
        const startMatch = sArgs.match(/^(\S+)\s+start\s+\S+\s*(.*)/);
        if (startMatch) {
          const cmdName = startMatch[1].replace(/-/g, " ");
          const ids = startMatch[2]?.trim();
          return ids ? `Start ${cmdName} (${ids})` : `View ${cmdName} fields`;
        }

        // <command> update <chatId> <entryId> --fields
        const updateMatch = sArgs.match(/^(\S+)\s+update\s+\S+\s+\S+\s*(.*)/);
        if (updateMatch) {
          const cmdName = updateMatch[1].replace(/-/g, " ");
          const flagsStr = updateMatch[2] || "";
          const fields: string[] = [];
          const flagRe = /--(\S+)\s+"([^"]+)"|--(\S+)\s+(\S+)/g;
          let m;
          while ((m = flagRe.exec(flagsStr))) {
            fields.push(m[1] || m[3]);
          }
          const detail = fields.length > 0 ? `: ${fields.join(", ")}` : "";
          return `Update ${cmdName}${detail}`;
        }

        // <command> submit <chatId>
        if (/^\S+\s+submit\b/.test(sArgs)) {
          const cmdName = sArgs.match(/^(\S+)/)?.[1]?.replace(/-/g, " ") ?? "";
          return `Submit ${cmdName}`;
        }

        // <command> list <chatId>
        if (/^\S+\s+list\b/.test(sArgs)) {
          const cmdName = sArgs.match(/^(\S+)/)?.[1]?.replace(/-/g, " ") ?? "";
          return `List ${cmdName} entries`;
        }

        // <command> get <chatId> <entryId>
        if (/^\S+\s+get\b/.test(sArgs)) {
          const cmdName = sArgs.match(/^(\S+)/)?.[1]?.replace(/-/g, " ") ?? "";
          return `View ${cmdName} entry`;
        }

        // <command> delete <chatId> <entryId>
        if (/^\S+\s+delete\b/.test(sArgs)) {
          const cmdName = sArgs.match(/^(\S+)/)?.[1]?.replace(/-/g, " ") ?? "";
          return `Delete ${cmdName} entry`;
        }

        // Fallback
        const sShort = sArgs.length > 80 ? sArgs.slice(0, 80) + "..." : sArgs;
        return `Structure: ${sShort}`;
      }

      const short = cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
      return `Running \`${short}\``;
    }
  } else if (["Read", "Write", "Edit"].includes(toolName)) {
    const path = input.file_path;
    if (typeof path === "string" && path) {
      const short = path.split("/").pop() ?? path;
      return `${label}: \`${short}\``;
    }
  } else if (toolName === "Grep") {
    const pat = input.pattern;
    if (typeof pat === "string" && pat) return `Searching for \`${pat}\``;
  } else if (toolName === "WebSearch") {
    const q = input.query;
    if (typeof q === "string" && q) {
      const short = q.length > 50 ? q.slice(0, 50) + "..." : q;
      return `Searching: "${short}"`;
    }
  } else if (toolName === "Agent" || toolName === "Task") {
    const desc = (input.description ?? input.prompt) as string | undefined;
    if (desc) {
      const short = desc.length > 50 ? desc.slice(0, 50) + "..." : desc;
      return `Subagent: ${short}`;
    }
  }

  return label;
}
