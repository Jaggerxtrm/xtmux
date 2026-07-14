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
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth++;
    } else if (character === "}") {
      depth--;
      if (depth === 0) return index + 1;
      if (depth < 0) return null;
    }
  }
  return null;
}

function hasCoordinationField(text: string): boolean {
  return /"(?:duplicate|recipientId|messageKey|senderId|status|acked|doubleEnter|sent|target)"\s*:/.test(text);
}

function malformedJsonResult(error: unknown): Error {
  return new Error(`Malformed xtmux JSON result: ${error instanceof Error ? error.message : String(error)}`);
}

export function coordinationResult(content: unknown): CoordinationResult | null {
  const text = textOf(content);
  if (!text.startsWith("{")) return null;

  const objectEnd = findJsonObjectEnd(text);
  if (objectEnd === null) {
    if (hasCoordinationField(text)) throw malformedJsonResult("incomplete JSON object");
    return null;
  }

  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text.slice(0, objectEnd));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    value = parsed as Record<string, unknown>;
  } catch (error) {
    if (!hasCoordinationField(text.slice(0, objectEnd))) return null;
    throw malformedJsonResult(error);
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
