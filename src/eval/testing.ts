// Test support: a scripted fake OpenAI-compatible model server, plus an
// "oracle" script that solves any task by replaying its reference solution
// through real tool calls. Lets the whole harness (real agent loop, real
// tools, real checks) be exercised with no actual model.
import { createServer, type Server } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { ChatMessage } from "../types.js";
import type { TaskSpec } from "./types.js";

export interface ScriptedReply {
  content?: string;
  toolCalls?: { name: string; arguments: object | string }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  status?: number;
  delayMs?: number;
}

export interface ScriptContext {
  messages: ChatMessage[];
  call: number; // 1-based index of this chat request
}

export interface ScriptedModel {
  baseUrl: string;
  calls: () => number;
  close: () => Promise<void>;
}

export async function startScriptedModel(handler: (ctx: ScriptContext) => ScriptedReply): Promise<ScriptedModel> {
  let calls = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/models") return void res.end(JSON.stringify({ data: [{ id: "scripted" }] }));
      if (req.url !== "/v1/chat/completions") {
        res.statusCode = 404;
        return void res.end("{}");
      }
      calls++;
      const reply = handler({ messages: (JSON.parse(body) as { messages: ChatMessage[] }).messages, call: calls });
      const respond = () => {
        res.statusCode = reply.status ?? 200;
        if (reply.status && reply.status >= 400) return void res.end(JSON.stringify({ error: "scripted failure" }));
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: reply.content ?? null,
                  ...(reply.toolCalls
                    ? {
                        tool_calls: reply.toolCalls.map((t, i) => ({
                          id: `call_${calls}_${i}`,
                          type: "function",
                          function: { name: t.name, arguments: typeof t.arguments === "string" ? t.arguments : JSON.stringify(t.arguments) },
                        })),
                      }
                    : {}),
                },
              },
            ],
            ...(reply.usage ? { usage: reply.usage } : {}),
          })
        );
      };
      if (reply.delayMs) setTimeout(respond, reply.delayMs);
      else respond();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls: () => calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function walk(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full, root) : [path.relative(root, full).split(path.sep).join("/")];
  });
}

// Solves whichever task the conversation is about: writes every file of the
// task's reference solution with write_file, then says it is done. For an
// answer task it just replies with the reference answer.
export function oracleScript(tasks: TaskSpec[]): (ctx: ScriptContext) => ScriptedReply {
  return ({ messages }) => {
    const prompt = messages.find((m) => m.role === "user")?.content;
    const task = tasks.find((t) => t.prompt === prompt);
    if (!task) return { content: "I don't know this task." };
    if (messages[messages.length - 1]!.role === "tool") return { content: "Done." };

    const solutionDir = path.join(task.dir, "solution");
    const files = walk(solutionDir);
    if (files.includes("reply.txt")) return { content: readFileSync(path.join(solutionDir, "reply.txt"), "utf-8") };
    return {
      toolCalls: files.map((rel) => ({
        name: "write_file",
        arguments: { path: rel, content: readFileSync(path.join(solutionDir, rel), "utf-8"), overwrite: true },
      })),
    };
  };
}
