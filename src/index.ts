/**
 * Deep Agent Memory Reproduction Test
 *
 * Reproduces two bugs with observational memory enabled + 30+ tool calls:
 *   1. Not all tool calls are persisted / recalled
 *   2. Messages come back out of order after recall + UI transform
 *
 * Setup is an EXACT replica of:
 *   - apps/backend/src/mastra/agent-helpers/models/default-agent-settings.ts
 *   - apps/backend/src/mastra/agent-helpers/models/default-stream-settings.ts
 *   - apps/backend/src/mastra/agent-helpers/routes/create-chat-stream-route.ts
 *   - apps/backend/src/trpc/routers/engagement/deep-agent-chat.ts (getSession)
 *
 * Self-contained — no imports from apps/backend.
 *
 * Usage:
 *   bun run test              # single-turn test (35+ tool calls)
 *   bun run test:multi        # adds a second turn to test multi-turn ordering
 */

import "dotenv/config";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";
import { PostgresStore } from "@mastra/pg";
import { z } from "zod";

const loadAISdk = () => Promise.all([
  import("@mastra/ai-sdk"),
  import("@mastra/ai-sdk/ui"),
  import("ai"),
]);

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const MULTI_TURN = process.argv.includes("--multi-turn");
const NO_OM = process.argv.includes("--no-om");

// ─────────────────────────────────────────────────────────────────────────────
// 1. Storage — exact production setup (PostgresStore from @mastra/pg)
// ─────────────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL in .env");
  process.exit(1);
}

const storage = new PostgresStore({ id: "repro-test", connectionString: DATABASE_URL });

// ─────────────────────────────────────────────────────────────────────────────
// 2. Memory — exact production config from default-agent-settings.ts
//
//    createAgentMemory({ generateTitle: true }) merges with defaultMemoryConfig:
//      lastMessages: 200
//      observationalMemory:
//        scope: "thread"
//        model: "google/gemini-2.5-flash"
//        observation.messageTokens: 50_000
//        observation.bufferTokens: 0.3
//        reflection.observationTokens: 150_000
//        shareTokenBudget: false
// ─────────────────────────────────────────────────────────────────────────────

const omConfig = NO_OM ? undefined : {
  scope: "thread" as const,
  model: "google/gemini-2.5-flash",
  observation: {
    messageTokens: 50_000,
    bufferTokens: 0.3,
  },
  reflection: {
    observationTokens: 150_000,
  },
  shareTokenBudget: false,
};

const memory = new Memory({
  storage,
  options: {
    generateTitle: true,
    lastMessages: 200,
    ...(omConfig && { observationalMemory: omConfig }),
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Tools — simple tools that force 35+ calls reliably
// ─────────────────────────────────────────────────────────────────────────────

const NUM_FILES = 35;

const fileContents: Record<string, string> = {};
for (let i = 1; i <= NUM_FILES; i++) {
  const name = `document-${String(i).padStart(2, "0")}.pdf`;
  fileContents[name] = [
    `=== ${name} ===`,
    `This is a ${["financial", "legal", "operational", "strategic", "market"][i % 5]} document.`,
    `Key metric: revenue of $${(i * 127_000).toLocaleString()}.`,
    `Risk rating: ${["low", "medium", "high"][i % 3]}.`,
    `Contains ${i + 10} pages of analysis on the deal structure.`,
  ].join("\n");
}

const listFiles = createTool({
  id: "listFiles",
  description: "List all files available in the data room",
  inputSchema: z.object({}),
  outputSchema: z.object({
    files: z.array(z.object({ name: z.string(), sizeKb: z.number() })),
  }),
  execute: async () => {
    return {
      files: Object.keys(fileContents).map((name, i) => ({
        name,
        sizeKb: (i + 1) * 42,
      })),
    };
  },
});

const readFile = createTool({
  id: "readFile",
  description: "Read the full contents of a single data room file by name",
  inputSchema: z.object({
    fileName: z.string().describe("Exact file name from listFiles"),
  }),
  outputSchema: z.object({
    content: z.string(),
    pages: z.number(),
  }),
  execute: async ({ context }: any) => {
    const name = context.fileName;
    const content = fileContents[name] || `File not found: ${name}`;
    return { content, pages: Math.floor(Math.random() * 20) + 5 };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Agent — exact production setup
//
//    From deep-agent.ts + default-agent-settings.ts:
//      - memory: observational memory (above)
//      - defaultOptions: { autoResumeSuspendedTools: false, maxSteps: 75 }
//      - inputProcessors: [] (we skip the production-specific ones)
//      - outputProcessors: []
//
//    Model: anthropic/claude-sonnet-4-5 (same as production default)
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a research assistant that analyzes data room files.

MANDATORY WORKFLOW — follow these steps EXACTLY:
1. Call listFiles to get the full file list.
2. Call readFile for EVERY file returned — one call per file, do not skip any.
3. After reading ALL files, write a brief summary of what you found.

CRITICAL RULES:
- You MUST call readFile individually for each file. No batching, no skipping.
- Do NOT stop reading files early. Read all of them.
- After reading all files, provide a 2-3 sentence summary.`;

const agent = new Agent({
  id: "deep-agent-repro",
  name: "Deep Agent Reproduction",
  instructions: SYSTEM_PROMPT,
  model: "anthropic/claude-sonnet-4-5",
  tools: { listFiles, readFile },
  memory,
  defaultOptions: {
    autoResumeSuspendedTools: false,
    maxSteps: 75,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Stream settings — exact production config from default-stream-settings.ts
// ─────────────────────────────────────────────────────────────────────────────

// Mirrors getDefaultModelSettings("deep-agent")
const modelSettings = {
  maxOutputTokens: 100_000,
  providerOptions: {
    anthropic: {
      sendReasoning: true,
      thinking: { type: "enabled", budgetTokens: 10_000 },
    },
    google: {
      thinkingConfig: { thinkingLevel: "medium", includeThoughts: true },
    },
    openai: {
      reasoningEffort: "medium",
      promptCacheKey: "o11-chat-v1",
      promptCacheRetention: "24h",
    },
  },
};

// Mirrors defaultStreamParameters
const streamParameters = {
  maxSteps: 100,
  // savePerStep: true,  // COMMENTED OUT — matches production exactly
  toolCallConcurrency: 1,
};

// Mirrors getTemperatureForProvider("anthropic")
const temperature = 0.2;

// ─────────────────────────────────────────────────────────────────────────────
// 6. Check functions
// ─────────────────────────────────────────────────────────────────────────────

interface CheckResult {
  totalMessages: number;
  toolCallsSeen: string[];
  toolResultsSeen: string[];
  ordering: { isCorrect: boolean; violations: string[] };
  dataOmCount: number;
}

async function checkRawDb(threadId: string): Promise<CheckResult> {
  const store = await storage.getStore("memory");
  if (!store) throw new Error("No memory store");

  const all = await store.listMessages({ threadId, perPage: false as any });
  const msgs = all.messages;

  const toolCalls: string[] = [];
  const toolResults: string[] = [];
  let dataOmCount = 0;
  const violations: string[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] as any;
    const parts = m.content?.parts || [];

    for (const p of parts) {
      if (p.type === "tool-invocation") {
        if (p.toolInvocation?.state === "call" || p.toolInvocation?.state === "partial-call") {
          toolCalls.push(p.toolInvocation.toolName);
        }
        if (p.toolInvocation?.state === "result") {
          toolResults.push(p.toolInvocation.toolName);
        }
      }
      if (typeof p.type === "string" && p.type.startsWith("data-om")) {
        dataOmCount++;
      }
    }

    // Check ordering: createdAt should be monotonically non-decreasing
    if (i > 0) {
      const prev = new Date((msgs[i - 1] as any).createdAt).getTime();
      const curr = new Date(m.createdAt).getTime();
      if (curr < prev) {
        violations.push(
          `msg[${i}] createdAt (${m.createdAt}) < msg[${i - 1}] createdAt (${(msgs[i - 1] as any).createdAt})`
        );
      }
    }
  }

  // Check role ordering: user messages should come before their assistant responses
  const roles = msgs.map((m: any) => m.role);
  for (let i = 1; i < roles.length; i++) {
    if (roles[i] === "user" && roles[i - 1] === "assistant") {
      // This is fine — it's a new turn
    }
    if (roles[i] === "user" && i > 0 && roles[i - 1] === "user") {
      violations.push(`Consecutive user messages at indices ${i - 1} and ${i}`);
    }
  }

  return {
    totalMessages: msgs.length,
    toolCallsSeen: toolCalls,
    toolResultsSeen: toolResults,
    ordering: { isCorrect: violations.length === 0, violations },
    dataOmCount,
  };
}

async function checkRecall(threadId: string, resourceId: string): Promise<CheckResult> {
  // Exact replica of deep-agent-chat.ts getSession recall
  const { messages: rawMessages } = await memory.recall({
    threadId,
    resourceId,
    perPage: 500,
  });

  // Exact filter from getSession: remove messages whose ONLY parts are data-om-*
  const messages = (rawMessages || []).filter((m: any) => {
    const parts = m.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) return true;
    return !parts.every((p: any) => typeof p.type === "string" && p.type.startsWith("data-om"));
  });

  const toolCalls: string[] = [];
  const toolResults: string[] = [];
  let dataOmCount = 0;
  const violations: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any;
    const parts = m.content?.parts || [];

    for (const p of parts) {
      if (p.type === "tool-invocation") {
        if (p.toolInvocation?.state === "call" || p.toolInvocation?.state === "partial-call") {
          toolCalls.push(p.toolInvocation.toolName);
        }
        if (p.toolInvocation?.state === "result") {
          toolResults.push(p.toolInvocation.toolName);
        }
      }
      if (typeof p.type === "string" && p.type.startsWith("data-om")) {
        dataOmCount++;
      }
    }

    if (i > 0) {
      const prev = new Date((messages[i - 1] as any).createdAt).getTime();
      const curr = new Date(m.createdAt).getTime();
      if (curr < prev) {
        violations.push(
          `recalled msg[${i}] createdAt (${m.createdAt}) < msg[${i - 1}] createdAt (${(messages[i - 1] as any).createdAt})`
        );
      }
    }
  }

  // Check that tool calls and results are paired
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    for (const p of ((m as any).content?.parts || [])) {
      if (p.type === "tool-invocation") {
        const id = p.toolInvocation?.toolCallId;
        if (p.toolInvocation?.state === "call") callIds.add(id);
        if (p.toolInvocation?.state === "result") resultIds.add(id);
      }
    }
  }
  for (const id of callIds) {
    if (!resultIds.has(id)) violations.push(`Tool call ${id} has no matching result`);
  }
  for (const id of resultIds) {
    if (!callIds.has(id)) violations.push(`Tool result ${id} has no matching call`);
  }

  return {
    totalMessages: messages.length,
    toolCallsSeen: toolCalls,
    toolResultsSeen: toolResults,
    ordering: { isCorrect: violations.length === 0, violations },
    dataOmCount,
  };
}

async function checkUiRender(threadId: string, resourceId: string): Promise<CheckResult & { uiMessages: any[] }> {
  const [, { toAISdkV5Messages }] = await loadAISdk();

  // Exact replica of deep-agent-chat.ts getSession
  const { messages: rawMessages } = await memory.recall({
    threadId,
    resourceId,
    perPage: 500,
  });

  const filtered = (rawMessages || []).filter((m: any) => {
    const parts = m.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) return true;
    return !parts.every((p: any) => typeof p.type === "string" && p.type.startsWith("data-om"));
  });

  // This is exactly what getSession does: (await loadAISdkMessages())(messages)
  const uiMessages: any[] = toAISdkV5Messages(filtered);

  const toolCalls: string[] = [];
  const toolResults: string[] = [];
  let dataOmCount = 0;
  const violations: string[] = [];

  // toAISdkV5Messages transforms DB parts into two different shapes:
  //
  //   DB format (from recall):
  //     { type: "tool-invocation", toolInvocation: { state: "result", toolName, toolCallId, args, result } }
  //
  //   UI format (from toAISdkV5Messages):
  //     { type: "tool-{toolName}", toolCallId, input, output, state: "output-available", ... }
  //     OR { type: "tool-invocation", toolInvocation: { ... } }
  //
  // We detect both formats.

  function isToolPart(p: any): boolean {
    if (p.type === "tool-invocation") return true;
    if (typeof p.type === "string" && p.type.startsWith("tool-") && !p.type.startsWith("tool-invocation")) {
      return !!p.toolCallId || !!p.toolInvocation;
    }
    return false;
  }

  function getToolName(p: any): string {
    if (p.toolInvocation?.toolName) return p.toolInvocation.toolName;
    if (p.toolName) return p.toolName;
    if (typeof p.type === "string" && p.type.startsWith("tool-")) return p.type.replace("tool-", "");
    return "unknown";
  }

  function getToolState(p: any): string {
    return p.toolInvocation?.state ?? p.state ?? "unknown";
  }

  function getToolCallId(p: any): string {
    return p.toolInvocation?.toolCallId ?? p.toolCallId ?? "";
  }

  for (let i = 0; i < uiMessages.length; i++) {
    const m = uiMessages[i];
    const parts = m.parts || [];

    for (const p of parts) {
      if (isToolPart(p)) {
        const state = getToolState(p);
        const name = getToolName(p);
        // DB format uses "call"/"result", UI format uses "output-available"/"partial-call"
        if (state === "call" || state === "partial-call") {
          toolCalls.push(name);
        }
        if (state === "result" || state === "output-available") {
          toolResults.push(name);
        }
      }
    }

    if (i > 0 && m.role === "user" && uiMessages[i - 1].role === "user") {
      violations.push(`UI: consecutive user messages at ${i - 1} and ${i}`);
    }
  }

  // Check tool invocation ordering within assistant messages
  for (const m of uiMessages) {
    if (m.role !== "assistant") continue;
    const parts = m.parts || [];
    const invocations = parts.filter(isToolPart);

    const callIdToIndex = new Map<string, number>();
    for (let i = 0; i < invocations.length; i++) {
      const inv = invocations[i];
      const state = getToolState(inv);
      const id = getToolCallId(inv);
      if (state === "call" || state === "partial-call") {
        callIdToIndex.set(id, i);
      }
    }

    for (let i = 0; i < invocations.length; i++) {
      const inv = invocations[i];
      const state = getToolState(inv);
      const id = getToolCallId(inv);
      const name = getToolName(inv);
      if (state === "result" || state === "output-available") {
        const callIdx = callIdToIndex.get(id);
        if (callIdx === undefined) {
          violations.push(`UI: tool ${name} (${id}) has state="${state}" but no preceding "call" state`);
        } else if (callIdx > i) {
          violations.push(`UI: result for ${name} appears before its call`);
        }
      }
    }
  }

  return {
    totalMessages: uiMessages.length,
    toolCallsSeen: toolCalls,
    toolResultsSeen: toolResults,
    ordering: { isCorrect: violations.length === 0, violations },
    dataOmCount,
    uiMessages,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Stream execution — exact replica of create-chat-stream-route.ts
// ─────────────────────────────────────────────────────────────────────────────

async function runStream(
  chatId: string,
  resourceId: string,
  userMessage: string,
): Promise<{ toolCallsDuringStream: string[]; stepCount: number }> {
  const [{ toAISdkStream }, , { createUIMessageStream, createUIMessageStreamResponse }] = await loadAISdk();
  const { RequestContext } = await import("@mastra/core/request-context");

  const abortController = new AbortController();

  // Build requestContext exactly like the route
  const requestContext = new RequestContext();
  requestContext.set("organizationId", "test-org-id");
  requestContext.set("chatId", chatId);
  requestContext.set("chatType", "deep-agent");
  requestContext.set("sessionId", chatId);
  requestContext.set("userId", "test-user-id");
  requestContext.set("planName", "pro");
  requestContext.set("baseUrl", "http://localhost:5101");
  requestContext.set("abortSignal", abortController.signal);

  // Ensure thread exists (exactly like the route's blind upsert)
  const memStore = await storage.getStore("memory");
  if (memStore) {
    await memStore.saveThread({
      thread: {
        id: chatId,
        resourceId,
        title: "",
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  // extractLatestForMemory: in production, only the latest user message is sent
  // (memory recalls the rest). This is exactly what the route does.
  const memoryMessages = [{ role: "user" as const, content: userMessage }];

  const toolCallsDuringStream: string[] = [];
  let stepCount = 0;

  // Stream with EXACT route options
  const stream = await agent.stream(memoryMessages as any, {
    ...streamParameters,
    requestContext,
    abortSignal: abortController.signal,
    runId: `run_${chatId}_${Date.now()}`,
    modelSettings: {
      ...modelSettings,
      ...(temperature !== undefined && { temperature }),
    },
    providerOptions: { ...modelSettings.providerOptions },
    memory: {
      thread: chatId,
      resource: resourceId,
    },
    outputProcessors: [],
    prepareStep: () => {
      if (abortController.signal.aborted) throw new Error("Aborted");
      return {};
    },
    onStepFinish: (result: any) => {
      stepCount++;
      // Mastra wraps AI SDK tool calls — name lives in payload or nested fields
      const tcs = result.toolCalls || [];
      for (const tc of tcs) {
        const name = tc.toolName ?? tc.name ?? tc.payload?.toolName ?? tc.payload?.name ?? "?";
        toolCallsDuringStream.push(name);
      }
      const trs = result.toolResults || [];
      if (tcs.length === 0 && trs.length > 0) {
        for (const tr of trs) {
          const name = tr.toolName ?? tr.name ?? "?";
          toolCallsDuringStream.push(name);
        }
      }
      // Summarize step
      const names = [...tcs, ...trs].map((t: any) =>
        t.toolName ?? t.name ?? t.payload?.toolName ?? t.payload?.name ?? "?"
      );
      if (names.length > 5) {
        const counts = new Map<string, number>();
        for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
        const summary = [...counts].map(([n, c]) => c > 1 ? `${n}x${c}` : n).join(", ");
        process.stdout.write(`    step ${stepCount}: ${summary}\n`);
      } else if (names.length > 0) {
        process.stdout.write(`    step ${stepCount}: ${names.join(", ")}\n`);
      } else if (result.text) {
        process.stdout.write(`    step ${stepCount}: [text response]\n`);
      }
    },
  } as any);

  // Consume with toAISdkStream → createUIMessageStream → createUIMessageStreamResponse
  // This is EXACTLY what the route does
  const uiStream = createUIMessageStream({
    execute: async ({ writer }: any) => {
      for await (const part of toAISdkStream(stream, {
        from: "agent",
        sendStart: true,
        sendFinish: true,
        sendReasoning: true,
      }) as any) {
        try {
          writer.write(part);
        } catch {
          if (!abortController.signal.aborted) {
            abortController.abort();
          }
          break;
        }
      }
    },
  });

  // Consume the HTTP response body (simulates client reading the stream)
  const response = createUIMessageStreamResponse({ stream: uiStream });
  const reader = response.body!.getReader();
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value?.length || 0;
  }

  process.stdout.write(`    stream consumed: ${totalBytes} bytes, ${stepCount} steps\n`);
  return { toolCallsDuringStream, stepCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Report
// ─────────────────────────────────────────────────────────────────────────────

function printCheckResult(label: string, result: CheckResult, expectedToolCalls: number) {
  const { totalMessages, toolCallsSeen, toolResultsSeen, ordering, dataOmCount } = result;

  const callCount = toolCallsSeen.length;
  const resultCount = toolResultsSeen.length;
  const callsOk = resultCount >= expectedToolCalls;
  const orderOk = ordering.isCorrect;

  console.log(`\n  [${label}]`);
  console.log(`    messages:       ${totalMessages}`);
  console.log(`    tool calls:     ${callCount}`);
  console.log(`    tool results:   ${resultCount} / ${expectedToolCalls} expected`);
  console.log(`    data-om parts:  ${dataOmCount}`);
  console.log(`    persistence:    ${callsOk ? "PASS" : "FAIL"} — ${resultCount}/${expectedToolCalls} tool results persisted`);
  console.log(`    ordering:       ${orderOk ? "PASS" : "FAIL"}`);

  if (!orderOk) {
    for (const v of ordering.violations.slice(0, 10)) {
      console.log(`      ⚠ ${v}`);
    }
    if (ordering.violations.length > 10) {
      console.log(`      ... and ${ordering.violations.length - 10} more`);
    }
  }

  if (!callsOk) {
    const expected = new Set<string>();
    for (let i = 1; i <= NUM_FILES; i++) expected.add(`readFile`);
    expected.add("listFiles");

    const resultNames = new Map<string, number>();
    for (const name of toolResultsSeen) {
      resultNames.set(name, (resultNames.get(name) || 0) + 1);
    }

    const listFilesCount = resultNames.get("listFiles") || 0;
    const readFileCount = resultNames.get("readFile") || 0;
    console.log(`      listFiles results: ${listFilesCount}`);
    console.log(`      readFile results:  ${readFileCount} / ${NUM_FILES} expected`);
  }

  return { callsOk, orderOk };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const chatId = `repro-${Date.now()}`;
  const resourceId = `test-org_test-engagement_deep`;

  console.log("=".repeat(72));
  console.log("DEEP AGENT MEMORY REPRODUCTION TEST");
  console.log(`  chatId:     ${chatId}`);
  console.log(`  resourceId: ${resourceId}`);
  console.log(`  multiTurn:  ${MULTI_TURN}`);
  console.log(`  OM enabled: ${!NO_OM}`);
  console.log(`  config:`);
  console.log(`    lastMessages:   200`);
  console.log(`    observational:  ${NO_OM ? "DISABLED" : "thread scope, google/gemini-2.5-flash"}`);
  console.log(`    messageTokens:  ${NO_OM ? "N/A" : "50,000  (bufferTokens: 0.3 → ~15k)"}`);
  console.log(`    maxSteps:       100 (stream) / 75 (agent default)`);
  console.log(`    savePerStep:    OFF (commented out — matches production)`);
  console.log(`    toolConcurrency: 1 (serial)`);
  console.log("=".repeat(72));

  // ── Turn 1 ────────────────────────────────────────────────────────────────

  console.log("\n── TURN 1: Streaming 35+ tool calls ──");
  const { toolCallsDuringStream } = await runStream(
    chatId,
    resourceId,
    "Analyze all the files in the data room. Read every single file and give me a summary.",
  );

  const expectedToolCalls = toolCallsDuringStream.length;
  console.log(`\n  Tool calls during stream: ${expectedToolCalls}`);
  console.log(`    listFiles: ${toolCallsDuringStream.filter(t => t === "listFiles").length}`);
  console.log(`    readFile:  ${toolCallsDuringStream.filter(t => t === "readFile").length}`);

  // Wait for async saves + observational memory background tasks
  console.log("\n  Waiting 5s for async persistence + observational memory...");
  await sleep(5_000);

  // ── Check 1: Raw DB ────────────────────────────────────────────────────────

  console.log("\n── CHECK 1: Raw Database Persistence ──");
  const dbResult = await checkRawDb(chatId);
  const { callsOk: dbCallsOk, orderOk: dbOrderOk } = printCheckResult("RAW DB", dbResult, expectedToolCalls);

  // ── Check 2: Memory Recall (like tRPC getSession) ─────────────────────────

  console.log("\n── CHECK 2: Memory Recall (mirrors getSession) ──");
  const recallResult = await checkRecall(chatId, resourceId);
  const { callsOk: recallCallsOk, orderOk: recallOrderOk } = printCheckResult("RECALL", recallResult, expectedToolCalls);

  // ── Check 3: UI Render (toAISdkV5Messages like getSession) ─────────────────

  console.log("\n── CHECK 3: UI Render (mirrors getSession → useChat) ──");
  const uiResult = await checkUiRender(chatId, resourceId);
  const { callsOk: uiCallsOk, orderOk: uiOrderOk } = printCheckResult("UI RENDER", uiResult, expectedToolCalls);

  // Print UI message structure for debugging
  console.log("\n  UI message structure:");
  for (const m of uiResult.uiMessages) {
    const parts = m.parts || [];
    const partSummary = parts.map((p: any) => {
      if (p.type === "text") return `text(${p.text?.length || 0}ch)`;
      if (p.type === "tool-invocation") return `tool:${p.toolInvocation?.toolName}[${p.toolInvocation?.state}]`;
      if (p.type === "reasoning") return "reasoning";
      if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        const state = p.toolInvocation?.state ?? p.state ?? "?";
        return `${p.type}[${state}]`;
      }
      return p.type;
    });
    console.log(`    ${m.role}: ${partSummary.join(", ") || "(empty)"}`);
  }

  // Dump raw structure of first tool part for debugging
  for (const m of uiResult.uiMessages) {
    const firstTool = (m.parts || []).find((p: any) =>
      typeof p.type === "string" && p.type.startsWith("tool-") && p.type !== "tool-invocation"
    );
    if (firstTool) {
      console.log("\n  Sample tool part (raw):");
      console.log(`    type: ${JSON.stringify(firstTool.type)}`);
      console.log(`    toolInvocation: ${JSON.stringify(firstTool.toolInvocation ? { state: firstTool.toolInvocation.state, toolName: firstTool.toolInvocation.toolName, toolCallId: firstTool.toolInvocation.toolCallId } : null)}`);
      console.log(`    toolName: ${JSON.stringify(firstTool.toolName)}`);
      console.log(`    toolCallId: ${JSON.stringify(firstTool.toolCallId)}`);
      console.log(`    state: ${JSON.stringify(firstTool.state)}`);
      console.log(`    keys: ${JSON.stringify(Object.keys(firstTool))}`);
      break;
    }
  }

  // Also dump first raw DB message part structure for comparison
  const rawDbStore = await storage.getStore("memory");
  if (rawDbStore) {
    const rawMsgs = await rawDbStore.listMessages({ threadId: chatId, perPage: false as any });
    for (const m of rawMsgs.messages) {
      const firstToolPart = ((m as any).content?.parts || []).find((p: any) => p.type === "tool-invocation");
      if (firstToolPart) {
        console.log("\n  Sample DB tool part (raw):");
        console.log(`    type: ${JSON.stringify(firstToolPart.type)}`);
        console.log(`    toolInvocation.state: ${JSON.stringify(firstToolPart.toolInvocation?.state)}`);
        console.log(`    toolInvocation.toolName: ${JSON.stringify(firstToolPart.toolInvocation?.toolName)}`);
        console.log(`    toolInvocation.toolCallId: ${JSON.stringify(firstToolPart.toolInvocation?.toolCallId)}`);
        console.log(`    toolInvocation keys: ${JSON.stringify(firstToolPart.toolInvocation ? Object.keys(firstToolPart.toolInvocation) : null)}`);
        break;
      }
    }
  }

  // ── Wait for OM async and re-check ─────────────────────────────────────────

  console.log("\n  Waiting 15s more for observational memory async completion...");
  await sleep(15_000);

  console.log("\n── CHECK 4: Post-OM Raw Database ──");
  const dbResult2 = await checkRawDb(chatId);
  const { callsOk: dbCallsOk2, orderOk: dbOrderOk2 } = printCheckResult("RAW DB (post-OM)", dbResult2, expectedToolCalls);

  console.log("\n── CHECK 5: Post-OM Recall ──");
  const recallResult2 = await checkRecall(chatId, resourceId);
  const { callsOk: recallCallsOk2, orderOk: recallOrderOk2 } = printCheckResult("RECALL (post-OM)", recallResult2, expectedToolCalls);

  console.log("\n── CHECK 6: Post-OM UI Render ──");
  const uiResult2 = await checkUiRender(chatId, resourceId);
  const { callsOk: uiCallsOk2, orderOk: uiOrderOk2 } = printCheckResult("UI RENDER (post-OM)", uiResult2, expectedToolCalls);

  // ── Turn 2 (optional) ─────────────────────────────────────────────────────

  let turn2Results: {
    dbCallsOk: boolean; dbOrderOk: boolean;
    recallCallsOk: boolean; recallOrderOk: boolean;
    uiCallsOk: boolean; uiOrderOk: boolean;
  } | null = null;

  if (MULTI_TURN) {
    console.log("\n\n── TURN 2: Follow-up message ──");
    const { toolCallsDuringStream: turn2Tools } = await runStream(
      chatId,
      resourceId,
      "Now re-read the first 5 files and tell me which ones have the highest revenue.",
    );

    const totalExpected = expectedToolCalls + turn2Tools.length;
    console.log(`\n  Turn 2 tool calls: ${turn2Tools.length}`);
    console.log(`  Total expected (both turns): ${totalExpected}`);

    await sleep(5_000);

    console.log("\n── CHECK 7: Multi-turn Raw DB ──");
    const mt_db = await checkRawDb(chatId);
    const { callsOk: mt_dbOk, orderOk: mt_dbOrd } = printCheckResult("RAW DB (multi-turn)", mt_db, totalExpected);

    console.log("\n── CHECK 8: Multi-turn Recall ──");
    const mt_recall = await checkRecall(chatId, resourceId);
    const { callsOk: mt_recallOk, orderOk: mt_recallOrd } = printCheckResult("RECALL (multi-turn)", mt_recall, totalExpected);

    console.log("\n── CHECK 9: Multi-turn UI Render ──");
    const mt_ui = await checkUiRender(chatId, resourceId);
    const { callsOk: mt_uiOk, orderOk: mt_uiOrd } = printCheckResult("UI RENDER (multi-turn)", mt_ui, totalExpected);

    // Check that Turn 1 user message is still present
    const turn1UserMsgPresent = mt_ui.uiMessages.some(
      (m: any) => m.role === "user" && m.parts?.some((p: any) => p.type === "text" && p.text?.includes("Analyze all the files"))
    );
    const turn2UserMsgPresent = mt_ui.uiMessages.some(
      (m: any) => m.role === "user" && m.parts?.some((p: any) => p.type === "text" && p.text?.includes("re-read the first"))
    );
    console.log(`\n    Turn 1 user msg present: ${turn1UserMsgPresent ? "YES" : "NO ← MISSING"}`);
    console.log(`    Turn 2 user msg present: ${turn2UserMsgPresent ? "YES" : "NO ← MISSING"}`);

    // Check turn ordering: all Turn 1 messages should come before Turn 2
    const userMsgIndices = mt_ui.uiMessages
      .map((m: any, i: number) => m.role === "user" ? i : -1)
      .filter((i: number) => i >= 0);
    if (userMsgIndices.length >= 2) {
      const orderedCorrectly = userMsgIndices[0] < userMsgIndices[1];
      console.log(`    Turn ordering correct:   ${orderedCorrectly ? "YES" : "NO ← OUT OF ORDER"}`);
    }

    turn2Results = {
      dbCallsOk: mt_dbOk, dbOrderOk: mt_dbOrd,
      recallCallsOk: mt_recallOk, recallOrderOk: mt_recallOrd,
      uiCallsOk: mt_uiOk, uiOrderOk: mt_uiOrd,
    };
  }

  // ── Final Summary ──────────────────────────────────────────────────────────

  console.log("\n" + "=".repeat(72));
  console.log("FINAL SUMMARY");
  console.log("=".repeat(72));

  const allPersistenceChecks = [dbCallsOk, recallCallsOk, uiCallsOk, dbCallsOk2, recallCallsOk2, uiCallsOk2];
  const allOrderingChecks = [dbOrderOk, recallOrderOk, uiOrderOk, dbOrderOk2, recallOrderOk2, uiOrderOk2];

  if (turn2Results) {
    allPersistenceChecks.push(turn2Results.dbCallsOk, turn2Results.recallCallsOk, turn2Results.uiCallsOk);
    allOrderingChecks.push(turn2Results.dbOrderOk, turn2Results.recallOrderOk, turn2Results.uiOrderOk);
  }

  const persistencePassed = allPersistenceChecks.every(Boolean);
  const orderingPassed = allOrderingChecks.every(Boolean);

  console.log(`\n  BUG 1 — Tool calls not persisted:  ${persistencePassed ? "NOT REPRODUCED" : "REPRODUCED"}`);
  console.log(`  BUG 2 — Messages out of order:     ${orderingPassed ? "NOT REPRODUCED" : "REPRODUCED"}`);

  if (!persistencePassed) {
    console.log("\n  DETAILS (persistence):");
    console.log(`    Expected tool results:     ${expectedToolCalls}`);
    console.log(`    DB immediate:              ${dbResult.toolResultsSeen.length}`);
    console.log(`    DB post-OM:                ${dbResult2.toolResultsSeen.length}`);
    console.log(`    Recall immediate:          ${recallResult.toolResultsSeen.length}`);
    console.log(`    Recall post-OM:            ${recallResult2.toolResultsSeen.length}`);
    console.log(`    UI immediate:              ${uiResult.toolResultsSeen.length}`);
    console.log(`    UI post-OM:                ${uiResult2.toolResultsSeen.length}`);
  }

  if (!orderingPassed) {
    console.log("\n  DETAILS (ordering — tool call/result pairing):");
    console.log(`    Tool "call" state parts in DB:    ${dbResult.toolCallsSeen.length}`);
    console.log(`    Tool "result" state parts in DB:  ${dbResult.toolResultsSeen.length}`);
    console.log(`    → Missing "call" states means tool invocations`);
    console.log(`      are persisted with only "result" state.`);
    console.log(`      The "call" state (showing tool was invoked with`);
    console.log(`      specific args) is never saved to the database.`);
    if (!dbOrderOk) console.log(`    DB immediate violations:   ${dbResult.ordering.violations.length}`);
    if (!dbOrderOk2) console.log(`    DB post-OM violations:     ${dbResult2.ordering.violations.length}`);
    if (!recallOrderOk) console.log(`    Recall immediate violations: ${recallResult.ordering.violations.length}`);
    if (!recallOrderOk2) console.log(`    Recall post-OM violations:   ${recallResult2.ordering.violations.length}`);
    if (!uiOrderOk) console.log(`    UI immediate violations:   ${uiResult.ordering.violations.length}`);
    if (!uiOrderOk2) console.log(`    UI post-OM violations:     ${uiResult2.ordering.violations.length}`);
  }

  // Additional analysis: data-om message inflation
  if (dbResult2.dataOmCount > 0) {
    console.log(`\n  OBSERVATIONAL MEMORY ANALYSIS:`);
    console.log(`    data-om parts in DB:  ${dbResult2.dataOmCount}`);
    console.log(`    Total DB messages:    ${dbResult2.totalMessages}`);
    console.log(`    lastMessages limit:   200`);
    console.log(`    → OM parts inflate the message count. With many`);
    console.log(`      tool calls + OM parts, the 200 message limit`);
    console.log(`      can push older messages out of recall scope.`);
  }

  console.log("\n" + "=".repeat(72));

  // Exit with non-zero if any bug was reproduced
  const exitCode = (!persistencePassed || !orderingPassed) ? 1 : 0;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("\nFATAL ERROR:", err);
  process.exit(2);
});
