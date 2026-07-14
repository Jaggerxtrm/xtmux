export type MessageErrorCode =
  | "XTMUX_ALREADY_FULFILLED"
  | "XTMUX_MESSAGE_KEY_CONFLICT"
  | "XTMUX_INVALID_CORRELATION"
  | "XTMUX_WRONG_RECIPIENT"
  | "XTMUX_WRONG_PANE"
  | "XTMUX_ENDPOINT_OVERRIDE"
  | "XTMUX_REPLY_TERMINAL"
  | "XTMUX_MESSAGE_NOT_FOUND";

export class MessageError extends Error {
  readonly code: MessageErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: MessageErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "MessageError";
    this.code = code;
    this.detail = detail;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}
