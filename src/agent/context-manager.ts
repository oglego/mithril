import type { ApiToolDefinition, ChatMessage, ToolCall } from "../types.js";
import { estimateMessageTokens } from "./context.js";
import { isDeclinedResult } from "./tool-results.js";

// The summary of dropped conversation lives at the END OF THE SYSTEM MESSAGE,
// not in a mid-conversation message. Several chat templates (Mistral-style
// ones in particular) reject consecutive user messages or system messages
// after the first, so appending to the system prompt is the one placement
// that is valid for every template.
export const SUMMARY_HEADING = "## Earlier conversation (condensed to save context)";
const SUMMARY_MARKER = `\n\n${SUMMARY_HEADING}\n`;

// The newest blocks are never pruned in the first pass: the model is most
// likely to be working from them right now.
const KEEP_RECENT_BLOCKS = 2;

// Tool results shorter than this aren't worth replacing with a stub.
const STUB_THRESHOLD_CHARS = 240;
const STUB_PREFIX = "[Earlier ";

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

// How much of the context window may be used by the prompt. The rest is
// headroom for the model's reply: 20% of the window, but never less than 512
// or more than 4096 tokens.
export function inputBudgetFor(contextWindow: number): number {
  const reserve = Math.min(4096, Math.max(512, Math.round(contextWindow * 0.2)));
  return Math.max(256, contextWindow - reserve);
}

// ---------------------------------------------------------------------------
// Token estimation, calibrated against what the server reports
// ---------------------------------------------------------------------------

// chars/4 is a decent average but varies a lot by model and content (code and
// non-English text tokenize much worse). OpenAI-compatible servers report the
// real prompt size in `usage.prompt_tokens`; this learns the ratio between
// our estimate and that ground truth and applies it to later estimates.
export class TokenCalibrator {
  private _factor = 1;
  private _samples = 0;

  get factor(): number {
    return this._factor;
  }
  get samples(): number {
    return this._samples;
  }

  observe(rawEstimate: number, actualTokens: number): void {
    if (!(rawEstimate > 0) || !(actualTokens > 0)) return;
    const ratio = Math.min(4, Math.max(0.5, actualTokens / rawEstimate));
    this._factor = this._samples === 0 ? ratio : this._factor * 0.5 + ratio * 0.5;
    this._samples++;
  }

  apply(rawEstimate: number): number {
    return Math.ceil(rawEstimate * this._factor);
  }
}

// ---------------------------------------------------------------------------
// Capping a single oversized tool result
// ---------------------------------------------------------------------------

// Keeps the start and the end (where errors and summaries usually are) and
// cuts the middle.
export function capToolResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = (n: number) => `\n\n[... ${n} characters omitted to fit the context window ...]\n\n`;
  const budget = Math.max(0, maxChars - marker(text.length).length);
  const headLen = Math.ceil(budget * 0.6);
  const tailLen = budget - headLen;
  const omitted = text.length - headLen - tailLen;
  return text.slice(0, headLen) + marker(omitted) + (tailLen > 0 ? text.slice(text.length - tailLen) : "");
}

// ---------------------------------------------------------------------------
// Blocks and exchanges
// ---------------------------------------------------------------------------

// A block is the smallest unit that can be removed without breaking the
// OpenAI message contract: an assistant message with tool_calls always travels
// with its tool responses.
interface Block {
  messages: ChatMessage[];
}

function groupBlocks(messages: ChatMessage[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const group = [msg];
      i++;
      while (i < messages.length && messages[i]!.role === "tool") {
        group.push(messages[i]!);
        i++;
      }
      blocks.push({ messages: group });
    } else {
      blocks.push({ messages: [msg] });
      i++;
    }
  }
  return blocks;
}

function isUserBlock(block: Block): boolean {
  return block.messages.length === 1 && block.messages[0]!.role === "user";
}

// An exchange is one user message plus everything that followed it. Old
// history is dropped in whole exchanges so the conversation never starts with
// an assistant message (which strict templates reject).
function groupExchanges(blocks: Block[]): Block[][] {
  const exchanges: Block[][] = [];
  for (const block of blocks) {
    if (isUserBlock(block) || exchanges.length === 0) exchanges.push([block]);
    else exchanges[exchanges.length - 1]!.push(block);
  }
  return exchanges;
}

// ---------------------------------------------------------------------------
// Deterministic summary of dropped conversation
// ---------------------------------------------------------------------------

// Built from facts we can extract mechanically (what the user asked, which
// files were changed or read, which commands ran and how they ended), rather
// than by asking the model to summarize itself. That costs no extra model
// call and doesn't depend on a small model summarizing well.
interface SummaryState {
  userRequests: string[];
  conclusions: string[];
  filesChanged: string[];
  filesRead: string[];
  commands: { command: string; exit: string }[];
  otherTools: Map<string, number>;
  declined: number;
}

function emptyState(): SummaryState {
  return {
    userRequests: [],
    conclusions: [],
    filesChanged: [],
    filesRead: [],
    commands: [],
    otherTools: new Map(),
    declined: 0,
  };
}

function isEmptyState(s: SummaryState): boolean {
  return (
    s.userRequests.length === 0 &&
    s.conclusions.length === 0 &&
    s.filesChanged.length === 0 &&
    s.filesRead.length === 0 &&
    s.commands.length === 0 &&
    s.otherTools.size === 0 &&
    s.declined === 0
  );
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function addUnique(list: string[], value: string): void {
  const existing = list.indexOf(value);
  if (existing !== -1) list.splice(existing, 1); // move to most-recent position
  list.push(value);
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  const raw: unknown = call.function.arguments;
  try {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function absorbBlock(state: SummaryState, block: Block): void {
  const first = block.messages[0]!;

  if (isUserBlock(block)) {
    state.userRequests.push(oneLine(first.content, 160));
    return;
  }

  if (first.role === "assistant" && (!first.tool_calls || first.tool_calls.length === 0)) {
    if (first.content.trim().length > 0) state.conclusions.push(oneLine(first.content, 200));
    return;
  }

  for (const call of first.tool_calls ?? []) {
    const args = parseArgs(call);
    const result = block.messages.find((m) => m.role === "tool" && m.tool_call_id === call.id)?.content ?? "";
    const name = call.function.name;
    const declined = isDeclinedResult(name, result);
    const path = typeof args.path === "string" ? args.path : undefined;

    if ((name === "write_file" || name === "edit_file") && path) {
      if (declined) state.declined++;
      else if (result.startsWith("Successfully")) addUnique(state.filesChanged, path);
    } else if (name === "read_file" && path) {
      addUnique(state.filesRead, path);
    } else if (name === "run_command" && typeof args.command === "string") {
      if (declined) state.declined++;
      else {
        const exit = /\[Exit code: (-?\d+)/.exec(result)?.[1] ?? "?";
        state.commands.push({ command: oneLine(args.command, 80), exit });
      }
    } else {
      state.otherTools.set(name, (state.otherTools.get(name) ?? 0) + 1);
    }
  }
}

const SUMMARY_FOOTER =
  "This is only a summary. Re-read files or re-run commands if you need their exact current contents.";

// Renders the state as markdown, trimming the oldest entries first until it
// fits `maxChars`.
function renderSummary(state: SummaryState, maxChars: number): string {
  if (isEmptyState(state)) return "";

  const build = (keep: number): string => {
    const tail = <T>(xs: T[]): T[] => xs.slice(-keep);
    const lines: string[] = [];
    if (state.userRequests.length)
      lines.push(`- The user asked, oldest to newest: ${tail(state.userRequests).map((r) => `"${r}"`).join("; ")}`);
    if (state.filesChanged.length) lines.push(`- Files you modified: ${tail(state.filesChanged).join(", ")}`);
    if (state.filesRead.length) lines.push(`- Files you read: ${tail(state.filesRead).join(", ")}`);
    if (state.commands.length)
      lines.push(
        `- Commands you ran: ${tail(state.commands).map((c) => `\`${c.command}\` (exit ${c.exit})`).join("; ")}`
      );
    if (state.otherTools.size)
      lines.push(`- Other tool calls: ${[...state.otherTools].map(([n, c]) => `${n}×${c}`).join(", ")}`);
    if (state.declined) lines.push(`- Actions the user declined: ${state.declined}`);
    if (state.conclusions.length)
      lines.push(`- Your earlier conclusions: ${tail(state.conclusions).map((c) => `"${c}"`).join("; ")}`);
    lines.push(SUMMARY_FOOTER);
    return lines.join("\n");
  };

  for (let keep = 8; keep >= 1; keep--) {
    const text = build(keep);
    if (text.length <= maxChars) return text;
  }
  const smallest = build(1);
  return smallest.length <= maxChars ? smallest : smallest.slice(0, Math.max(0, maxChars - 1)) + "…";
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

export interface CompactionReport {
  changed: boolean;
  prunedResults: number;
  droppedMessages: number;
  tokensBefore: number;
  tokensAfter: number;
  // Tokens that can never be compacted away: the system prompt (without any
  // summary) plus the tool definitions.
  fixedTokens: number;
  // False when even the most aggressive compaction can't fit the prompt in
  // the budget. The caller should stop rather than send an oversized request.
  fits: boolean;
}

// The smallest context window that leaves comfortable room for conversation
// on top of `fixedTokens` of unavoidable overhead (rounded up to 256).
export function suggestedWindowFor(fixedTokens: number): number {
  const needed = (fixedTokens + 1500) / 0.8;
  return Math.ceil(needed / 256) * 256;
}

export interface ContextManagerOptions {
  contextWindow: number;
  // Defaults to inputBudgetFor(contextWindow). Mainly useful in tests.
  maxInputTokens?: number;
}

export class ContextManager {
  readonly contextWindow: number;
  readonly maxInputTokens: number;
  readonly calibrator = new TokenCalibrator();

  private state: SummaryState = emptyState();
  private baseSystem: string | undefined;
  private lastRawPromptEstimate = 0;
  private overheadRaw = 0;
  private totals = { compactions: 0, prunedResults: 0, droppedMessages: 0 };

  constructor(options: ContextManagerOptions) {
    this.contextWindow = options.contextWindow;
    this.maxInputTokens = options.maxInputTokens ?? inputBudgetFor(options.contextWindow);
  }

  // A tool result bigger than this is cut as it arrives, so a single huge
  // output can't blow the budget on its own. At least 2000 chars, otherwise a
  // quarter of the input budget.
  get maxToolResultChars(): number {
    return Math.max(2000, Math.floor(this.maxInputTokens * 4 * 0.25));
  }

  // Call with the real usage from the server's response to the prompt that
  // prepare() last produced.
  observeUsage(promptTokens: number | undefined): void {
    if (promptTokens !== undefined) this.calibrator.observe(this.lastRawPromptEstimate, promptTokens);
  }

  private est(message: ChatMessage): number {
    return this.calibrator.apply(estimateMessageTokens(message));
  }

  private summaryBudgetChars(): number {
    return Math.min(4000, Math.max(600, Math.floor(this.maxInputTokens * 4 * 0.12)));
  }

  // Brings `history` within budget, in place. Cheapest measures first:
  //   1. stub out old tool results (they dominate context in coding sessions)
  //   2. condense whole old exchanges into the summary in the system message
  //   3. last resort inside the current task: stub then drop its older steps
  //   4. truncate the newest tool results
  // The system prompt and the newest user message are never removed.
  prepare(history: ChatMessage[], toolDefs?: ApiToolDefinition[]): CompactionReport {
    const noop = (tokens: number, fits = true): CompactionReport => ({
      changed: false, prunedResults: 0, droppedMessages: 0, tokensBefore: tokens, tokensAfter: tokens, fixedTokens: 0, fits,
    });
    if (history.length === 0) return noop(0);

    if (toolDefs) this.overheadRaw = Math.ceil(JSON.stringify(toolDefs).length / 4);
    const overhead = this.calibrator.apply(this.overheadRaw);

    // Work on a copy of the system message so we can append the summary.
    const original = history[0]!;
    const hasSystem = original.role === "system";
    const markerAt = original.content.indexOf(SUMMARY_MARKER);
    const base = hasSystem ? (markerAt === -1 ? original.content : original.content.slice(0, markerAt)) : "";
    if (this.baseSystem !== undefined && base !== this.baseSystem) this.state = emptyState(); // new conversation
    this.baseSystem = base;

    const system: ChatMessage = hasSystem ? { ...original } : { role: "system", content: "" };
    const rest = hasSystem ? history.slice(1) : history.slice();
    let exchanges = groupExchanges(groupBlocks(rest));

    const applySummary = () => {
      if (!hasSystem) return;
      const text = renderSummary(this.state, this.summaryBudgetChars());
      system.content = text ? base + SUMMARY_MARKER + text : base;
    };
    applySummary();

    const flat = () => exchanges.flat();
    const total = () =>
      overhead + (hasSystem ? this.est(system) : 0) + flat().reduce((s, b) => s + b.messages.reduce((t, m) => t + this.est(m), 0), 0);
    const finish = (before: number, pruned: number, dropped: number): CompactionReport => {
      const after = total();
      const changed = pruned > 0 || dropped > 0;
      const blocks = flat();
      history.length = 0;
      if (hasSystem) history.push(system);
      for (const b of blocks) history.push(...b.messages);
      // Safety: a conversation must not open with an orphaned tool message.
      while (history.length > (hasSystem ? 1 : 0) && history[hasSystem ? 1 : 0]!.role === "tool") history.splice(hasSystem ? 1 : 0, 1);

      this.lastRawPromptEstimate = this.overheadRaw + history.reduce((s, m) => s + estimateMessageTokens(m), 0);
      if (changed) {
        this.totals.compactions++;
        this.totals.prunedResults += pruned;
        this.totals.droppedMessages += dropped;
      }
      const fixedTokens = overhead + (hasSystem ? this.est({ ...system, content: base }) : 0);
      return { changed, prunedResults: pruned, droppedMessages: dropped, tokensBefore: before, tokensAfter: after, fixedTokens, fits: after <= this.maxInputTokens };
    };

    const before = total();
    if (before <= this.maxInputTokens) return finish(before, 0, 0);

    let pruned = 0;
    let dropped = 0;

    const argsFor = (block: Block, toolCallId: string | undefined): string => {
      const call = block.messages[0]?.tool_calls?.find((c) => c.id === toolCallId);
      if (!call) return "tool";
      const a = parseArgs(call);
      const name = call.function.name;
      if (typeof a.path === "string") return `${name} ${a.path}`;
      if (typeof a.command === "string") return `${name} \`${oneLine(a.command, 60)}\``;
      if (typeof a.query === "string") return `${name} "${oneLine(a.query, 60)}"`;
      return name;
    };

    // Replaces tool results in `block` with short stubs. Returns how many.
    const stubBlock = (block: Block): number => {
      let n = 0;
      block.messages = block.messages.map((m) => {
        if (m.role !== "tool" || m.content.length <= STUB_THRESHOLD_CHARS || m.content.startsWith(STUB_PREFIX)) return m;
        n++;
        return {
          ...m,
          content: `${STUB_PREFIX}${argsFor(block, m.tool_call_id)} result (${m.content.length} chars) was removed to save context. Call the tool again if you still need it.]`,
        };
      });
      return n;
    };

    // 1. Stub old tool results, oldest first, sparing the newest blocks.
    {
      const blocks = flat();
      const prunable = blocks.slice(0, Math.max(0, blocks.length - KEEP_RECENT_BLOCKS));
      for (const block of prunable) {
        pruned += stubBlock(block);
        if (total() <= this.maxInputTokens) return finish(before, pruned, dropped);
      }
    }

    // 2. Condense whole old exchanges (everything before the current task).
    while (exchanges.length > 1 && total() > this.maxInputTokens) {
      const oldest = exchanges.shift()!;
      for (const block of oldest) {
        absorbBlock(this.state, block);
        dropped += block.messages.length;
      }
      applySummary();
    }
    if (total() <= this.maxInputTokens) return finish(before, pruned, dropped);

    // From here on we're inside the current task: exchanges[0] starts with the
    // newest user message, which stays pinned.
    const current = exchanges[0]!;

    // 3a. Stub every remaining tool result except those in the final block.
    for (let i = 0; i < current.length - 1; i++) {
      pruned += stubBlock(current[i]!);
      if (total() <= this.maxInputTokens) return finish(before, pruned, dropped);
    }

    // 3b. Drop the task's oldest steps (never the pinned user message, never the final block).
    while (current.length > 2 && total() > this.maxInputTokens) {
      const index = isUserBlock(current[0]!) ? 1 : 0;
      const [removed] = current.splice(index, 1);
      absorbBlock(this.state, removed!);
      dropped += removed!.messages.length;
      applySummary();
    }
    if (total() <= this.maxInputTokens) return finish(before, pruned, dropped);

    // 4. Truncate what's left of the newest tool results to the room that remains.
    // Token estimates are rounded per message and include per-message
    // overhead, so a single computed cut can land a few tokens over budget.
    // Verify after cutting and shrink further until it fits (or give up).
    const last = current[current.length - 1]!;
    const originals = last.messages;
    const toolCount = originals.filter((m) => m.role === "tool").length;
    if (toolCount > 0) {
      const toolTokens = originals.reduce((s, m) => s + (m.role === "tool" ? this.est(m) : 0), 0);
      const room = this.maxInputTokens - (total() - toolTokens);
      let perMessageChars = Math.floor((room * 4 * 0.9) / (toolCount * Math.max(this.calibrator.factor, 0.5))) - 64;
      for (let attempt = 0; attempt < 6 && perMessageChars >= 200; attempt++) {
        let cut = 0;
        last.messages = originals.map((m) => {
          if (m.role !== "tool" || m.content.length <= perMessageChars) return m;
          cut++;
          return { ...m, content: capToolResult(m.content, perMessageChars) };
        });
        if (cut === 0 || total() <= this.maxInputTokens) {
          pruned += cut;
          break;
        }
        perMessageChars = Math.floor(perMessageChars * 0.8);
        if (attempt === 5 || perMessageChars < 200) pruned += cut;
      }
    }

    return finish(before, pruned, dropped);
  }

  // Overhead that no compaction can remove: system prompt + tool definitions.
  fixedPromptTokens(history: ChatMessage[], toolDefs?: ApiToolDefinition[]): number {
    const defsRaw = toolDefs ? Math.ceil(JSON.stringify(toolDefs).length / 4) : this.overheadRaw;
    const first = history[0];
    const baseContent = first?.role === "system" ? first.content.split(SUMMARY_MARKER)[0]! : "";
    return this.calibrator.apply(defsRaw) + (first?.role === "system" ? this.est({ ...first, content: baseContent }) : 0);
  }

  // Human-readable status for the /context command.
  describe(history: ChatMessage[], toolDefs?: ApiToolDefinition[]): string {
    const overheadRaw = toolDefs ? Math.ceil(JSON.stringify(toolDefs).length / 4) : this.overheadRaw;
    const overhead = this.calibrator.apply(overheadRaw);
    const used = overhead + history.reduce((s, m) => s + this.est(m), 0);
    const pct = Math.round((used / this.maxInputTokens) * 100);
    const n = (x: number) => x.toLocaleString("en-US");
    const calibration =
      this.calibrator.samples > 0
        ? `×${this.calibrator.factor.toFixed(2)} (learned from ${this.calibrator.samples} server reading${this.calibrator.samples === 1 ? "" : "s"})`
        : "not yet calibrated (using ~4 characters per token)";
    return [
      `Context window: ${n(this.contextWindow)} tokens (prompt budget ${n(this.maxInputTokens)}, rest reserved for replies)`,
      `Current prompt: ~${n(used)} tokens, ${pct}% of budget (~${n(overhead)} of that is tool definitions)`,
      `Token estimate: ${calibration}`,
      `Compactions this session: ${this.totals.compactions} (${this.totals.prunedResults} tool result(s) trimmed, ${this.totals.droppedMessages} message(s) condensed)`,
    ].join("\n");
  }
}

export function formatCompactionReport(r: CompactionReport): string {
  const k = (t: number) => (t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t));
  const parts: string[] = [];
  if (r.prunedResults > 0) parts.push(`${r.prunedResults} tool result(s) trimmed`);
  if (r.droppedMessages > 0) parts.push(`${r.droppedMessages} older message(s) condensed into a summary`);
  return `Context compacted: ${parts.join(", ")} (~${k(r.tokensBefore)} → ~${k(r.tokensAfter)} tokens).`;
}
