export type CoordinationResult =
  | { kind: "message-send"; messageKey: string; target: string }
  | { kind: "message-reply"; messageKey: string; replyToMessageKey: string; target: string }
  | { kind: "message-ack"; messageKey: string }
  | { kind: "safe-send-pointer"; target: string; replyToMessageKey?: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).join("").trim();
}

function findJsonObjectEnd(text: string): number | null {
  let depth = 0;
  let escaped = false;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth++;
    else if (character === "}") {
      depth--;
      if (depth === 0) return index + 1;
      if (depth < 0) return null;
    }
  }
  return null;
}

function hasCoordinationShape(text: string): boolean {
  const has = (field: string) => new RegExp(`"${field}"\\s*:`).test(text);
  return (has("messageKey") && has("recipientId"))
    || (has("messageKey") && has("status") && has("acked"))
    || (has("messageKey") && has("replyToMessageKey"))
    || (has("target") && has("sent") && has("doubleEnter"))
    || has("injection");
}

function hasAdditionalJsonValue(text: string): boolean {
  if (text.length > 2048) return true;
  for (let start = 0; start < text.length; start++) {
    if (text[start] === "{") {
      const end = findJsonObjectEnd(text.slice(start));
      if (end !== null) {
        try {
          if (record(JSON.parse(text.slice(start, start + end)))) return true;
        } catch {
          // Plain middleware diagnostics may contain non-JSON braces.
        }
      }
    }
    if (text[start] !== "[") continue;
    for (let end = start + 1; end < text.length; end++) {
      if (text[end] !== "]") continue;
      try {
        if (Array.isArray(JSON.parse(text.slice(start, end + 1)))) return true;
      } catch {
        // Bracketed diagnostics such as [done] are plain text, not JSON.
      }
    }
  }
  return false;
}

function malformedJsonResult(error: unknown): Error {
  return new Error(`Malformed xtmux JSON result: ${error instanceof Error ? error.message : String(error)}`);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function coordinationResult(content: unknown): CoordinationResult | null {
  const text = textOf(content);
  if (!text.startsWith("{")) return null;
  const objectEnd = findJsonObjectEnd(text);
  if (objectEnd === null) {
    if (hasCoordinationShape(text)) throw malformedJsonResult("incomplete JSON object");
    return null;
  }
  if (hasAdditionalJsonValue(text.slice(objectEnd))) return null;

  let value: Record<string, unknown>;
  try {
    const parsed = record(JSON.parse(text.slice(0, objectEnd)));
    if (!parsed) return null;
    value = parsed;
  } catch (error) {
    if (!hasCoordinationShape(text.slice(0, objectEnd))) return null;
    throw malformedJsonResult(error);
  }

  if ("replyToMessageKey" in value || "fulfilled" in value) {
    if (typeof value.messageKey !== "string" || typeof value.replyToMessageKey !== "string"
      || typeof value.fulfilled !== "boolean" || typeof value.senderId !== "string" || typeof value.recipientId !== "string") {
      throw new Error("Incompatible xtmux message-reply JSON result");
    }
    return { kind: "message-reply", messageKey: value.messageKey, replyToMessageKey: value.replyToMessageKey, target: value.recipientId };
  }
  if ("duplicate" in value || ("recipientId" in value && "messageKey" in value)) {
    if (typeof value.messageKey !== "string" || typeof value.duplicate !== "boolean" || typeof value.senderId !== "string" || typeof value.recipientId !== "string") {
      throw new Error("Incompatible xtmux message-send JSON result");
    }
    return { kind: "message-send", messageKey: value.messageKey, target: value.recipientId };
  }
  if ("status" in value && "messageKey" in value) {
    if (typeof value.messageKey !== "string" || typeof value.status !== "string" || typeof value.acked !== "boolean") {
      throw new Error("Incompatible xtmux message-ack JSON result");
    }
    return { kind: "message-ack", messageKey: value.messageKey };
  }

  const injection = "injection" in value ? record(value.injection) : value;
  if ("injection" in value || "doubleEnter" in value || ("sent" in value && "target" in value)) {
    if (!injection || typeof injection.target !== "string" || typeof injection.sent !== "boolean" || typeof injection.doubleEnter !== "boolean") {
      throw new Error("Incompatible xtmux safe-send-pointer JSON result");
    }
    if (!injection.sent) return null;
    const fulfilment = record(value.fulfilment);
    const replyToMessageKey = fulfilment?.replyToMessageKey;
    if (fulfilment && (typeof fulfilment.fulfilled !== "boolean" || typeof replyToMessageKey !== "string")) {
      throw new Error("Incompatible xtmux safe-send-pointer JSON result");
    }
    return { kind: "safe-send-pointer", target: injection.target, ...(typeof replyToMessageKey === "string" ? { replyToMessageKey } : {}) };
  }
  return null;
}
