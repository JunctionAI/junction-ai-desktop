// OpenMausBot server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { approvalKey, autoDecision } from "./auto-approve.ts";
import * as box from "./box.ts";
import * as composio from "./composio.ts";
import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";
import {
  containerComputerAction,
  containerComputerMcp,
  containerComputerScreenshot,
  containerComputerStatus,
  setupCommands,
  type LifecycleAction,
} from "./container-computer.ts";
import { ensureDirs, instanceConfigs, loadConfig, saveConfig, EVENTS_DIR, NATIVE_DIR } from "./config.ts";
import { resetPathCache } from "./env-path.ts";
import type { RuntimeEvent } from "./contracts.ts";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { mentionedBots, roomResponders, Store, type GroupDefaultResponder, type Message } from "./store.ts";
import * as tts from "./tts/index.ts";
import { narrateTool, toUtterances } from "./tts/speech-text.ts";
import { readCuaConnection } from "./local-computer.ts";
import { RoutineManager, type RoutineRunOn } from "./routines.ts";

const PORT = Number(process.env.OMB_PORT || process.env.OGB_PORT || 8799);
const STATIC_DIR = process.env.OMB_STATIC_DIR || null;
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

ensureDirs();
const cfg = loadConfig();
const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
await registry.load(instanceConfigs(cfg));

const bus = new EventBus();
bus.attach(registry.instances());

// ── peer-agent comms wiring ────────────────────────────
// A shared secret guards the localhost-only /api/internal endpoints the
// agents-proxy calls; regenerated each boot (the proxy gets it via env).
const COMMS_TOKEN = randomBytes(24).toString("hex");
const MAX_COMMS_DEPTH = 1;
const agentsProxyPath = (() => {
  const ts = join(dirname(fileURLToPath(import.meta.url)), "drivers", "agents-proxy.ts");
  return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
})();
const AGENTS_NODE_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

function agentsIntegration(botId: string, depth: number) {
  return {
    command: process.execPath,
    args: [agentsProxyPath],
    env: {
      ...AGENTS_NODE_FLAG,
      OMB_HARNESS_URL: `http://127.0.0.1:${PORT}`,
      OMB_BOT_ID: botId,
      OMB_COMMS_TOKEN: COMMS_TOKEN,
      OMB_TURN_DEPTH: String(depth),
    },
  };
}

function askBotAndWait(targetBotId: string, message: string, depth: number): Promise<string> {
  const target = store.bot(targetBotId);
  if (!target) return Promise.resolve("(no such bot)");
  const threadId = target.threadId;
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (out: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(out);
    };
    const unsub = bus.subscribe((e: RuntimeEvent) => {
      if (e.threadId !== threadId) return;
      if (e.type === "item.completed" && e.itemType === "assistant_text") {
        text += (text ? "\n" : "") + e.text;
      } else if (e.type === "turn.completed") {
        finish(text || "(the bot finished without a text reply)");
      }
    });
    const timer = setTimeout(() => finish(text || "(timed out waiting for the bot to reply)"), 4 * 60_000);
    startTurn(targetBotId, message, { commsDepth: depth + 1 }).catch((err) =>
      finish(`(couldn't start that bot: ${err instanceof Error ? err.message : String(err)})`),
    );
  });
}

async function defaultSelection() {
  const described = await registry.describe();
  const available = described.filter((d) => d.snapshot.state === "available");
  const pick = available.find((d) => d.driverKind === "claudeAgent") ?? available[0];
  return { instanceId: pick?.instanceId ?? "", model: pick?.models.default ?? "" };
}
let bootSelection = { instanceId: "", model: "" };
const store = new Store(() => bootSelection);
bootSelection = await defaultSelection();
store.seedIfEmpty();

const publicBot = (bot: NonNullable<ReturnType<typeof store.bot>>) => ({
  ...bot,
  messages: store.messagesFor(bot.threadId),
  activeLeafId: store.activeLeaf(bot.threadId),
  tasks: store.tasks(bot.id).map(({ resumeCursors, ...task }) => task),
});

const sseClients = new Set<ServerResponse>();
function broadcast(payload: unknown) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...sseClients]) {
    try { res.write(frame); } catch { sseClients.delete(res); }
  }
}

const toolMessageByItem = new Map<string, string>();
const askMessageByRequest = new Map<string, string>();
const groupSpeakers = new Map<string, { botId: string; name: string; color: string }>();
let routines: RoutineManager | null = null;
let activeVmThreadId: string | null = null;
let localVmLifecycleBusy = false;

bus.subscribe((event: RuntimeEvent) => {
  broadcast({ kind: "runtime", event });
  routines?.handleRuntimeEvent(event);
  const bot = store.botByThread(event.threadId);
  const group = bot ? undefined : store.groupByThread(event.threadId);
  if (!bot && !group) return;
  const speaker = group ? groupSpeakers.get(event.threadId) : undefined;
  const pushMessage = (m: Omit<Message, "id" | "at">) => {
    const message = store.appendMessage(event.threadId, group && m.role === "bot" ? { ...m, from: speaker } : m);
    broadcast({ kind: "message", threadId: event.threadId, message });
    return message;
  };
  switch (event.type) {
    case "session.started":
      if (bot && event.sessionId && event.providerInstanceId) {
        store.setResumeCursor(bot.id, event.providerInstanceId, event.sessionId, event.threadId);
      }
      break;
    case "item.completed":
      if (event.itemType === "assistant_text") {
        pushMessage({ role: "bot", kind: "text", text: event.text });
      } else if (event.itemType === "tool" && event.itemId) {
        const itemKey = `${event.threadId}:${event.itemId}`;
        const messageId = toolMessageByItem.get(itemKey);
        let toolName = "tool";
        if (messageId) {
          const existing = store.messagesFor(event.threadId).find((m) => m.id === messageId)?.tool;
          toolName = existing?.name ?? "tool";
          const patched = store.patchMessage(event.threadId, messageId, {
            tool: { name: toolName, ok: event.ok, spoken: existing?.spoken },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
          toolMessageByItem.delete(itemKey);
        }
        if (bot && /computer|screenshot|click|type_text|press_key|scroll|open_url/i.test(toolName)) {
          pokeScreenPoller(bot.id);
        }
      }
      break;
    case "item.started":
      if (event.itemType === "tool") {
        if (event.title?.endsWith("__ask_bot")) break;
        const name = event.title ?? "tool";
        const message = pushMessage({
          role: "bot",
          kind: "activity",
          tool: { name, spoken: narrateTool(name) ?? undefined },
        });
        if (event.itemId) toolMessageByItem.set(`${event.threadId}:${event.itemId}`, message.id);
      }
      break;
    case "request.opened": {
      const permission = event.requestType === "permission";
      const asker = bot ?? (speaker ? store.bot(speaker.botId) : undefined);
      const settled = permission && asker && event.requestId
        ? autoDecision(asker, event.tool, event.summary)
        : null;
      if (settled && asker && event.requestId) {
        const instance = event.providerInstanceId
          ? registry.get(event.providerInstanceId)
          : registry.get(asker.modelSelection.instanceId);
        const requestId = event.requestId;
        const { tool, summary } = event;
        void (async () => {
          try {
            if (!instance) throw new Error("provider unavailable");
            await instance.adapter.respondToRequest(event.threadId, requestId, { behavior: "allow" });
            pushMessage({
              role: "bot",
              kind: "activity",
              tool: { name: `${settled}: ${summary.slice(0, 120)}`, ok: true },
            });
          } catch {
            const card = pushMessage({
              role: "bot",
              kind: "options",
              card: {
                title: "Approval needed",
                subtitle: summary,
                options: ["Allow", "Deny"],
                requestId,
                tool,
                allowKey: approvalKey(tool, summary),
                held: "Auto mode couldn't answer this one.",
              },
            });
            askMessageByRequest.set(`${event.threadId}:${requestId}`, card.id);
          }
        })();
        break;
      }
      const message = pushMessage({
        role: "bot",
        kind: "options",
        card: {
          title: permission ? "Approval needed" : "Your bot has a question",
          subtitle: event.summary,
          options: event.choices?.length ? event.choices : permission ? ["Allow", "Deny"] : [],
          requestId: event.requestId,
          tool: permission ? event.tool : undefined,
          allowKey: permission ? approvalKey(event.tool, event.summary) : undefined,
          held: permission && asker?.autoApprove ? "This looked destructive, so auto mode stopped to ask." : undefined,
        },
      });
      if (event.requestId) askMessageByRequest.set(`${event.threadId}:${event.requestId}`, message.id);
      break;
    }
    case "request.resolved": {
      const messageId = event.requestId ? askMessageByRequest.get(`${event.threadId}:${event.requestId}`) : null;
      if (messageId) {
        const existing = store.messagesFor(event.threadId).find((m) => m.id === messageId);
        if (existing?.card && !existing.card.answered) {
          const patched = store.patchMessage(event.threadId, messageId, {
            card: { ...existing.card, answered: event.behavior, dismissed: event.source !== "user" },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
        }
        if (event.requestId) askMessageByRequest.delete(`${event.threadId}:${event.requestId}`);
      }
      break;
    }
    case "runtime.error":
      pushMessage({
        role: "bot",
        kind: "activity",
        tool: { name: `error: ${event.message.slice(0, 160)}`, ok: false, setup: event.setup },
      });
      break;
    case "turn.completed": {
      if (activeVmThreadId === event.threadId) activeVmThreadId = null;
      if (bot) {
        store.patchBot(bot.id, { busy: false, unread: true });
        broadcast({ kind: "bot", bot: store.bot(bot.id) });
        if (screenPollers.has(bot.id)) {
          void finalScreenFrame(bot.id).then((frame) => {
            if (frame && store.bot(bot.id)) {
              pushMessage({ role: "bot", kind: "screen", png: frame.png, mime: frame.mime });
            }
          });
        }
      }
      break;
    }
  }
});
