import { expect, test } from "bun:test";
import { coordinationResult } from "../../extensions/coordination-json.ts";

test("ignores unrelated JSON, NDJSON, and multi-command JSON", () => {
  const values = [
    '{"status":"running","items":[]}',
    '{"items":[]}\n{"other":"output"}',
    '{"messageKey":"m1","duplicate":false,"senderId":"$s","recipientId":"$r"}\n{"other":"output"}',
    '{"messageKey":"m1","duplicate":false,"senderId":"$s","recipientId":"$r"}\n["other"]',
    '{"messageKey":"m1","duplicate":false,"senderId":"$s","recipientId":"$r"}\n[done] {"other":1}',
    '[{"messageKey":"m1"}]',
  ];
  for (const value of values) {
    expect(() => coordinationResult(value)).not.toThrow();
    expect(coordinationResult(value)).toBeNull();
  }
});

test("recognizes exactly one coordination envelope before non-JSON middleware text", () => {
  expect(coordinationResult(JSON.stringify({
    messageKey: "m1", duplicate: false, senderId: "$sender", recipientId: "$recipient",
  }) + "\nwrapper output")).toEqual({ kind: "message-send", messageKey: "m1", target: "$recipient" });
  expect(coordinationResult(JSON.stringify({
    messageKey: "reply-1", duplicate: false, replyToMessageKey: "m1", fulfilled: true,
    senderId: "$recipient", recipientId: "$sender",
  }))).toEqual({ kind: "message-reply", messageKey: "reply-1", replyToMessageKey: "m1", target: "$sender" });
  expect(coordinationResult(JSON.stringify({
    messageKey: "m1", status: "acked", acked: true,
  }))).toEqual({ kind: "message-ack", messageKey: "m1" });
  expect(coordinationResult(JSON.stringify({
    injection: { target: "%recipient", sent: true, doubleEnter: true },
    fulfilment: { messageKey: "reply-m1", replyToMessageKey: "m1", fulfilled: true },
  }))).toEqual({ kind: "safe-send-pointer", target: "%recipient", replyToMessageKey: "m1" });
  const send = JSON.stringify({ messageKey: "m2", duplicate: false, senderId: "$sender", recipientId: "$recipient" });
  expect(coordinationResult(`${send}\n[done]`)).toEqual({ kind: "message-send", messageKey: "m2", target: "$recipient" });
  expect(coordinationResult(`${send}\n[auto-monitor] armed on $recipient`)).toEqual({
    kind: "message-send", messageKey: "m2", target: "$recipient",
  });
  expect(coordinationResult(`${send}\n[done] status {not-json}`)).toEqual({
    kind: "message-send", messageKey: "m2", target: "$recipient",
  });
});

test("retains actionable errors only for xtmux-shaped malformed output", () => {
  expect(() => coordinationResult('{"messageKey":"m1","recipientId":"$recipient"')).toThrow(
    "Malformed xtmux JSON result",
  );
  expect(() => coordinationResult('{"status":"running"')).not.toThrow();
  expect(coordinationResult('{"status":"running"')).toBeNull();
});

test("retains actionable errors for incompatible coordination contracts", () => {
  expect(() => coordinationResult(JSON.stringify({
    messageKey: "m1", duplicate: "false", senderId: "$sender", recipientId: "$recipient",
  }))).toThrow("Incompatible xtmux message-send JSON result");
  expect(() => coordinationResult(JSON.stringify({
    messageKey: "m1", status: "acked", acked: "true",
  }))).toThrow("Incompatible xtmux message-ack JSON result");
  expect(() => coordinationResult(JSON.stringify({
    injection: { target: "%recipient", sent: true, doubleEnter: "true" },
  }))).toThrow("Incompatible xtmux safe-send-pointer JSON result");
});
