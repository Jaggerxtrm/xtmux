import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export default function apiProbe(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "xtmux_api_probe",
    label: "xtmux API probe",
    description: "Compile/load probe for the pinned Pi extension API",
    parameters: Type.Object({ action: StringEnum(["ping"] as const) }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) return { content: [{ type: "text", text: "cancelled" }], details: {} };
      const result = await pi.exec("printf", ["%s", params.action], {
        ...(signal ? { signal } : {}),
        timeout: 1000,
      });
      return { content: [{ type: "text", text: result.stdout }], details: {} };
    },
  });
}
