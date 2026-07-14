import { expect, test } from "bun:test";
import { coordinationResult } from "../../extensions/coordination-json.ts";

test("ignores unrelated pretty JSON followed by middleware output", () => {
  const output = `{
  "status": "running",
  "items": []
}
sp result: no coordination message`;

  expect(() => coordinationResult(output)).not.toThrow();
  expect(coordinationResult(output)).toBeNull();
  expect(coordinationResult('{"items":[]}\n{"other":"output"}')).toBeNull();
});

test("recognizes compact coordination JSON before appended middleware text", () => {
  expect(coordinationResult(JSON.stringify({
    messageKey: "m1", duplicate: false, senderId: "$sender", recipientId: "$recipient",
  }) + "\nwrapper output")).toEqual({ kind: "message-send", target: "$recipient" });
  expect(coordinationResult(JSON.stringify({
    messageKey: "m1", status: "acked", acked: true,
  }) + "\nwrapper output")).toEqual({ kind: "message-ack", messageKey: "m1" });
  expect(coordinationResult(JSON.stringify({
    target: "%recipient", sent: true, doubleEnter: true,
  }) + "\nwrapper output")).toEqual({ kind: "safe-send-pointer", target: "%recipient" });
});

test("retains actionable errors for malformed intended coordination JSON", () => {
  expect(() => coordinationResult('{"messageKey":"m1","recipientId":"$recipient"')).toThrow(
    "Malformed xtmux JSON result",
  );
});

test("retains actionable errors for incompatible coordination contracts", () => {
  expect(() => coordinationResult(JSON.stringify({
    messageKey: "m1", duplicate: "false", senderId: "$sender", recipientId: "$recipient",
  }))).toThrow("Incompatible xtmux message-send JSON result");
  expect(() => coordinationResult(JSON.stringify({
    messageKey: "m1", status: "acked", acked: "true",
  }))).toThrow("Incompatible xtmux message-ack JSON result");
  expect(() => coordinationResult(JSON.stringify({
    target: "%recipient", sent: true, doubleEnter: "true",
  }))).toThrow("Incompatible xtmux safe-send-pointer JSON result");
});
