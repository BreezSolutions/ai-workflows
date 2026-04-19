import cron from "node-cron";
import * as db from "./db.js";
import { runWorkflow } from "./runner.js";
import type { Workflow } from "./types.js";

const activeCrons = new Map<string, cron.ScheduledTask>();

export async function startScheduler(): Promise<void> {
  console.log("Scheduler starting...");
  await loadWorkflows();

  // Reload workflows every 30 seconds to pick up changes
  setInterval(loadWorkflows, 30_000);
}

async function loadWorkflows(): Promise<void> {
  try {
    const workflows = await db.getEnabledWorkflows();

    // Stop crons for disabled/deleted workflows
    for (const [id, task] of activeCrons) {
      if (!workflows.find((w) => w.id === id)) {
        task.stop();
        activeCrons.delete(id);
        console.log(`Stopped cron for workflow ${id}`);
      }
    }

    for (const workflow of workflows) {
      if (workflow.trigger_type === "cron") {
        setupCron(workflow);
      }
      // Gmail polling and Slack triggers are handled elsewhere
    }
  } catch (err) {
    console.error("Error loading workflows:", err);
  }
}

function setupCron(workflow: Workflow): void {
  const schedule = workflow.trigger_config.cron ?? workflow.trigger_config.schedule;
  if (!schedule) return;

  // Skip if already running with same schedule
  if (activeCrons.has(workflow.id)) return;

  if (!cron.validate(schedule)) {
    console.error(`Invalid cron schedule for workflow ${workflow.id}: ${schedule}`);
    return;
  }

  const task = cron.schedule(schedule, async () => {
    console.log(`Cron triggered workflow: ${workflow.name} (${workflow.id})`);
    try {
      // Re-fetch to ensure we have latest config
      const current = await db.getWorkflow(workflow.id);
      if (!current || !current.enabled) return;

      const run = await db.createRun(workflow.id, "cron");
      await runWorkflow(current, run);
    } catch (err) {
      console.error(`Cron execution failed for ${workflow.id}:`, err);
    }
  }, { timezone: "America/Los_Angeles" });

  activeCrons.set(workflow.id, task);
  console.log(`Scheduled cron for "${workflow.name}": ${schedule}`);
}

export async function reloadScheduler(): Promise<void> {
  await loadWorkflows();
}
