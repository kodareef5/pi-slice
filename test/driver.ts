import slice from "../extension.ts";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { executable, staging } from "../workspace.ts";

export default function driver(pi: ExtensionAPI) {
  const tools = new Map(),
    gates: any[] = [];
  slice({
    ...pi,
    registerTool(tool) {
      tools.set(tool.name, tool);
      pi.registerTool(tool);
    },
    on(event: any, handler: any) {
      if (event === "tool_call") gates.push(handler);
      return pi.on(event, handler);
    },
  });
  pi.registerCommand("fixture", {
    description: "Test driver",
    async handler(args, ctx) {
      let result;
      try {
        const request = JSON.parse(args);
        if (request.op === "info")
          result = {
            cwd: ctx.cwd,
            processCwd: process.cwd(),
            agent: getAgentDir(),
            home: process.env.HOME,
            secret: process.env.PI_SLICE_TEST_SECRET === "fixture",
            umask: process.umask(),
            tools: pi.getActiveTools(),
            overridden: [...tools.keys()],
            trusted: ctx.isProjectTrusted(),
          };
        else if (request.op === "persist") {
          (ctx.sessionManager as any).appendMessage({
            role: "user",
            content: [{ type: "text", text: request.text || "fixture session" }],
            timestamp: Date.now(),
          });
          result = "saved";
        } else if (request.op === "cancel") {
          const abort = new AbortController();
          const timer = setTimeout(() => abort.abort(), 250);
          try {
            await tools.get(request.tool || "bash").execute("fixture", request.params || { command: request.command }, abort.signal, () => {}, ctx);
            result = "cancelled";
          } catch (error) {
            result = String(error);
          } finally {
            clearTimeout(timer);
          }
        } else if (["pack", "unpack", "extract"].includes(request.op)) {
          const feature = await import("../features/snapshot.ts"), temp = staging(getAgentDir());
          if (request.op === "pack") {
            const command = feature.captureCommand(executable("bun", ctx.cwd));
            const output = (await tools.get("bash").execute("fixture", {command: command + " | base64"}, undefined, () => {}, ctx)).structuredContent;
            if (output.exit_code !== 0) throw Error(output.output);
            result = join(temp, "workspace.tar");
            writeFileSync(result, Buffer.from(output.output, "base64"), {mode: 0o600});
            await feature.validate(result);
          }
          else if (request.op === "unpack") {
            await feature.unpack(request.file, temp, request.destination);
            result = "restored";
          } else {
            await feature.extract(request.file, temp);
            result = "extracted";
          }
        } else {
          for (const gate of gates) {
            const decision = await gate(
              { type: "tool_call", toolName: request.tool, input: request.params, toolCallId: "fixture" },
              ctx,
            );
            if (decision?.block) throw Error(decision.reason);
          }
          if (!tools.has(request.tool)) throw Error("No override: " + request.tool);
          result = await tools.get(request.tool).execute("fixture", request.params, undefined, () => {}, ctx);
        }
        ctx.ui.notify("FIXTURE:" + JSON.stringify({ result }), "info");
      } catch (error) {
        ctx.ui.notify("FIXTURE:" + JSON.stringify({ error: String(error) }), "info");
      }
    },
  });
}
