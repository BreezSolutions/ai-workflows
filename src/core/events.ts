import { EventEmitter } from "events";

export const bus = new EventEmitter();

export type WorkflowEvent = {
  type: "item_staged" | "item_completed" | "item_failed" | "run_started" | "run_completed" | "run_log";
  workflowId: string;
  workflowName?: string;
  runId?: string;
  itemId?: string;
  data?: any;
};

export function emit(event: WorkflowEvent) {
  bus.emit("workflow_event", event);
}
