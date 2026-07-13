export type CoordinationResult =
  | { kind: "message-send"; target: string }
  | { kind: "message-ack"; messageKey: string }
  | { kind: "safe-send-pointer"; target: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).join("").trim();
}

export function coordinationResult(content: unknown): CoordinationResult | null {
  const text = textOf(content);
  if (!text.startsWith("{")) return null;

  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    value = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Malformed xtmux JSON result: ${error instanceof Error ? error.message : String(error)}`);
  }

  if ("duplicate" in value || ("recipientId" in value && "messageKey" in value)) {
    if (typeof value.messageKey !== "string" || typeof value.duplicate !== "boolean" || typeof value.senderId !== "string" || typeof value.recipientId !== "string") {
      throw new Error("Incompatible xtmux message-send JSON result");
    }
    return { kind: "message-send", target: value.recipientId };
  }
  if ("status" in value && "messageKey" in value) {
    if (typeof value.messageKey !== "string" || typeof value.status !== "string" || typeof value.acked !== "boolean") {
      throw new Error("Incompatible xtmux message-ack JSON result");
    }
    return { kind: "message-ack", messageKey: value.messageKey };
  }
  if ("doubleEnter" in value || ("sent" in value && "target" in value)) {
    if (typeof value.target !== "string" || typeof value.sent !== "boolean" || typeof value.doubleEnter !== "boolean") {
      throw new Error("Incompatible xtmux safe-send-pointer JSON result");
    }
    return value.sent ? { kind: "safe-send-pointer", target: value.target } : null;
  }
  return null;
}
