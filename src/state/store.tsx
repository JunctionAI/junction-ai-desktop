// Server-backed store. The React app holds no transports of its own:
// it dispatches typed commands over HTTP and folds the one SSE event
// stream from the harness server into local state. The reducer stays
// pure; everything async lives in the wrapped dispatch + SSE fold.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { MausColor, MausMotion } from "@/lib/mascot";
import type { Routine, RoutineInput, RoutineRun } from "@/lib/routines";
import { currentCall } from "@/lib/call";
import { speaker } from "@/lib/tts";

export type { MausColor } from "@/lib/mascot";

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** permission asks: the tool being requested (drives the approval box) */
  tool?: string;
  /** why auto mode stopped to ask anyway */
  held?: string;
  /** the narrow grant "always allow" remembers, e.g. "Bash:git" */
  allowKey?: string;
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen";
  text?: string;
  card?: OptionCardData;
  /** activity messages: tool name + outcome. `spoken` is the server's
   * narration of the same chip ("reading a file"), used by call mode. */
  /** `setup` marks an error fixed by installing something, not by retrying. */
  tool?: { name: string; ok?: boolean; spoken?: string; setup?: boolean };
  /** screen messages: a frame of the bot's computer (base64) */
  png?: string;
  mime?: string;
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace — that's a fork. */
  parentId?: string | null;
  /** rooms: which member said this (sender attribution). */
  from?: { botId: string; name: string; color: MausColor };
  /** emoji reactions; by = "user" or a member botId. */
  reactions?: Array<{ emoji: string; by: string }>;
  /** comm chips: "Messaged @X" linking to the bot⇄bot channel. */
  comm?: { groupId: string; withBotId: string; withName: string; withColor: MausColor };
}

export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" };

/** A room: several bots + you in one shared thread. */
export interface Group {
  id: string;
  threadId: string;
  name: string;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;
  unread: boolean;
  createdAt: number;
  /** auto-created bot⇄bot channel (ask_bot exchanges mirror here) */
  dm?: boolean;
  busyBotId?: string | null;
  messages: Message[];
}

export interface ModelSelection {
  instanceId: string;
  model: string;
}

/** One of a bot's separate contexts: its own thread, transcript and
 * provider session. The bot's threadId points at the active one. */
export interface Task {
  threadId: string;
  title: string;
  createdAt: number;
}

export interface Bot {
  id: string;
  threadId: string;
  /** every context this bot has, newest first */
  tasks?: Task[];
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: string | null;
  unread: boolean;
  busy?: boolean;
  modelSelection: ModelSelection;
  /** Where this bot's computer runs; unset = auto (cloud box if one exists, else local). */
  computer?: "cloud" | "vm" | "local" | "off";
  /** auto mode: the bot approves its own tool permissions */
  autoApprove?: boolean;
  /** tools this bot may always use without asking */
  alwaysAllow?: string[];
  /** speak this bot's replies aloud as they settle */
  speakReplies?: boolean;
  /** this bot's own voice id (falls back to the app-wide one) */
  voice?: string;
  pinned?: boolean;
  hidden?: boolean;
  /** The workspace's one primary coordinator. */
  chiefOfStaff?: boolean;
  messages: Message[];
  /** leaf of the visible conversation branch (see visibleMessages) */
  activeLeafId?: string | null;
}

/** The visible conversation: walk parentId links from the active leaf back
 * to the root. Falls back to the flat list for pre-branching payloads. */
export function visibleMessages(bot: Bot): Message[] {
  const leafId = bot.activeLeafId;
  if (!leafId) return bot.messages;
  const byId = new Map(bot.messages.map((m) => [m.id, m]));
  if (!byId.has(leafId)) return bot.messages;
  const path: Message[] = [];
  let cur = byId.get(leafId);
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

/** All versions of a user message (itself + the forks that replaced it),
 * oldest first. Length 1 = never edited. */
export function messageVersions(bot: Bot, message: Message): Message[] {
  if (message.role !== "user" || message.kind !== "text") return [message];
  return bot.messages
    .filter(
      (m) => m.role === "user" && m.kind === "text" && (m.parentId ?? null) === (message.parentId ?? null),
    )
    .sort((a, b) => a.at - b.at);
}

/** GET /api/config — configured flags only; secrets are never echoed. */
export interface ConfigStatus {
  xai?: { configured: boolean };
  composio: { configured: boolean; apiKeyConfigured?: boolean };
  box: { configured: boolean };
  /** Voice (ElevenLabs). `configured` = a key is saved; `ready` = a key AND
   * a voice, which is what it takes to actually speak. The key itself is
   * never echoed back. */
  tts?: { configured: boolean; ready: boolean; voice: string };
  /** who's using the app — collected in onboarding, shown in the sidebar */
  profile?: { name: string; email: string };
}

/** How an engine gets installed — declared by its driver, mirrors
 * EngineInstall in server/contracts.ts. Absent for engines that need no
 * local binary. `command` omits platforms that have no one-liner. */
export interface EngineInstall {
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  docsUrl?: string;
  signInCommand?: string;
  needsNode?: boolean;
}

/** One row of GET /api/instances — the model picker's data. */
export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    version?: string | null;
  };
  models: { default: string; options: Array<{ id: string; label: string }> };
  capabilities?: { computerMcp?: boolean; agentsMcp?: boolean };
  install?: EngineInstall;
}

export type AppSettingsSection = "general" | "connections" | "voice" | "computer";

interface AppState {
  bots: Bot[];
  groups: Group[];
  instances: InstanceInfo[];
  config: ConfigStatus | null;
  /** selected chat — a bot id OR a group id */
  selectedId: string;
  activeView: "chat" | "routines";
  routines: Routine[];
  routineRuns: RoutineRun[];
  settingsOpen: boolean;
  pluginsOpen: boolean;
  computerOpen: boolean;
  appSettingsOpen: boolean;
  appSettingsSection: AppSettingsSection;
  /** latest live frame of a bot's computer, per botId */
  screens: Record<string, { png: string; mime: string }>;
  /** bots whose cloud computer is being provisioned */
  provisioning: Record<string, boolean>;
  connected: boolean;
  error: string | null;
  mascotMotion: {
    botId: string;
    nonce: number;
    kind: Exclude<MausMotion, "none">;
  } | null;
}
