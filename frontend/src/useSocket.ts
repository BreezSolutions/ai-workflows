import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

export interface WorkflowEvent {
  type: "item_staged" | "item_completed" | "item_failed" | "run_started" | "run_completed" | "folder_message" | "chat_system_message" | "backfill_started" | "backfill_complete";
  workflowId?: string;
  workflowName?: string;
  runId?: string;
  itemId?: string;
  folderId?: string;
  channelId?: string;
  conversation_id?: string;
  ok?: boolean;
  error?: string;
  data?: any;
}

export function useSocket(onEvent?: (event: WorkflowEvent) => void) {
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(window.location.origin.replace(":5173", ":8080"));
    socketRef.current = socket;

    socket.on("workflow_event", (event: WorkflowEvent) => {
      onEvent?.(event);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  return socketRef;
}

export interface Toast {
  id: number;
  message: string;
  type: "info" | "success" | "error";
}

let toastId = 0;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = (message: string, type: Toast["type"] = "info") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  };

  return { toasts, addToast };
}
