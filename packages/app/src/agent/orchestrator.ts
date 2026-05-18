/**
 * Agent Orchestrator — ReAct (Reason + Act) loop.
 *
 * Inspired by OpenHands' CodeAct pattern.
 * Takes a user message, builds a plan (planning mode), then executes
 * each step by calling LLM + MCP tools, observing outputs, and
 * self-correcting on failure.
 */
import { BrowserWindow } from 'electron';
import * as os from 'os';
import { getActiveLLMClient } from '../llm/client';
import { MCPRegistry } from '../mcp/registry';
import { getDb } from '../db/schema';
import OpenAI from 'openai';

const MAX_STEPS = 20;
const MAX_RETRIES = 3;

export interface WorkflowStep {
  index: number;
  description: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  status: 'pending' | 'running' | 'done' | 'failed';
  output?: string;
  error?: string;
}

export interface AgentPlan {
  workflowId: string;
  sessionId: string;
  goal: string;
  steps: WorkflowStep[];
  requiresApproval: boolean;
}

export class AgentOrchestrator {
  private window: BrowserWindow;
  private registry: MCPRegistry;
  private activePlans = new Map<string, AgentPlan>();

  constructor(window: BrowserWindow) {
    this.window = window;
    this.registry = MCPRegistry.getInstance();
  }

  /** Entry point: receive a user message and start the ReAct loop. */
  async handleMessage(sessionId: string, userContent: string): Promise<void> {
    const db = getDb();
    const workflowId = crypto.randomUUID();

    // Persist workflow state
    db.prepare(`
      INSERT INTO agent_states (workflow_id, session_id, status, context_json)
      VALUES (?, ?, 'pending', ?)
    `).run(workflowId, sessionId, JSON.stringify({ goal: userContent }));

    // Build context from session history
    const history = this.getSessionHistory(sessionId);

    // Step 1: Generate a plan
    const plan = await this.generatePlan(workflowId, sessionId, userContent, history);
    this.activePlans.set(workflowId, plan);

    // Step 2: If destructive actions detected, pause for approval
    if (plan.requiresApproval) {
      db.prepare(`UPDATE agent_states SET status='awaiting_approval', plan_json=? WHERE workflow_id=?`)
        .run(JSON.stringify(plan.steps), workflowId);
      this.emit('agent:planReady', plan);
      return; // Wait for approvePlan() IPC call
    }

    // Step 3: Execute immediately if safe
    await this.executePlan(plan);
  }

  /** Called when user approves or rejects a plan in Planning Mode. */
  async approvePlan(workflowId: string, approved: boolean): Promise<void> {
    const plan = this.activePlans.get(workflowId);
    if (!plan) return;
    if (!approved) {
      this.activePlans.delete(workflowId);
      this.emit('agent:token', '\n\n_Plan cancelled by user._');
      return;
    }
    await this.executePlan(plan);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async generatePlan(
    workflowId: string,
    sessionId: string,
    goal: string,
    history: OpenAI.ChatCompletionMessageParam[]
  ): Promise<AgentPlan> {
    const llm = getActiveLLMClient();
    const tools = this.registry.getToolSchemas();

    const planningPrompt: OpenAI.ChatCompletionMessageParam = {
      role: 'system',
      content: `You are Artha, a local-first AI productivity agent running on the user's Mac.

Available tools: ${tools.map(t => t.function.name).join(', ')}

Decompose the user's request into a clear, minimal step-by-step plan.

Respond ONLY with a valid JSON object (no markdown, no explanation):
{
  "steps": [
    { "index": 0, "description": "List files in ~/Desktop to see what screenshots exist", "toolName": "fs_list_directory" },
    { "index": 1, "description": "Create a Screenshots folder", "toolName": "fs_create_directory" },
    { "index": 2, "description": "Move each screenshot into the folder", "toolName": "fs_move_file" }
  ],
  "requiresApproval": true
}

Rules:
- Set requiresApproval=true whenever steps move, delete, or modify files
- Always start with fs_list_directory or fs_search_files before moving anything
- Keep steps minimal and concrete`,
    };

    const response = await llm.complete([planningPrompt, ...history, { role: 'user', content: goal }]);
    const raw = response.choices[0]?.message?.content ?? '{}';

    let parsed: { steps: WorkflowStep[]; requiresApproval: boolean };
    try {
      parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, ''));
    } catch {
      // Fallback: single-step plan
      parsed = {
        steps: [{ index: 0, description: goal, status: 'pending' }],
        requiresApproval: false,
      };
    }

    return {
      workflowId,
      sessionId,
      goal,
      steps: parsed.steps.map((s, i) => ({ ...s, index: i, status: 'pending' as const })),
      requiresApproval: parsed.requiresApproval,
    };
  }

  private async executePlan(plan: AgentPlan): Promise<void> {
    const db = getDb();
    const llm = getActiveLLMClient();
    const tools = this.registry.getToolSchemas();
    const homeDir = os.homedir();

    db.prepare(`UPDATE agent_states SET status='running' WHERE workflow_id=?`)
      .run(plan.workflowId);

    // Single-conversation ReAct loop.
    // The model keeps calling tools until it produces a final text response.
    // No step tracking — we let the model decide when it is done.
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are Artha, a local AI agent on a Mac. You have real filesystem tools.

Home: ${homeDir}
Desktop: ${homeDir}/Desktop
Documents: ${homeDir}/Documents
Downloads: ${homeDir}/Downloads

RULES — follow exactly:
1. Use tools to do ALL work. Never claim to have done something without calling a tool.
2. To organise files: call fs_search_files first to find them, then fs_create_directory for the folder, then fs_move_file for EVERY file — one call per file.
3. Do NOT stop calling tools until every single file is moved. Move them all before writing anything.
4. Destination path must include the filename, e.g. ${homeDir}/Desktop/Screenshots/Screenshot 1.png
5. Write a short summary ONLY after all tool calls are complete.`,
      },
      { role: 'user', content: plan.goal },
    ];

    // Allow enough iterations to handle directories with many files (up to 50 files)
    const MAX_ITERATIONS = 60;
    let iterations = 0;
    let emptyCount = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      let response: OpenAI.ChatCompletion;
      try {
        response = await llm.complete(messages, tools);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit('agent:token', `\n\n⚠️ Error: ${msg}`);
        break;
      }

      const msg = response.choices[0]?.message;
      if (!msg) break;

      messages.push({
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      });

      if (msg.tool_calls?.length) {
        // Execute every tool call the model requested, feed all results back.
        // Any text content alongside tool calls is intermediate reasoning — discard it.
        for (const toolCall of msg.tool_calls) {
          this.emit('agent:toolCall', {
            type: 'tool_invoke',
            name: toolCall.function.name,
            args: toolCall.function.arguments,
          });

          let toolResult: string;
          const toolStart = Date.now();
          let toolStatus: 'ok' | 'error' = 'ok';
          try {
            toolResult = await this.registry.invokeTool(
              toolCall.function.name,
              JSON.parse(toolCall.function.arguments)
            );
          } catch (err) {
            toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
            toolStatus = 'error';
          }

          // Persist invocation to audit log (non-critical)
          try {
            db.prepare(`
              INSERT INTO tool_audit_log
                (session_id, workflow_id, tool_name, args_json, result, duration_ms, status)
              VALUES (?,?,?,?,?,?,?)
            `).run(
              plan.sessionId, plan.workflowId,
              toolCall.function.name, toolCall.function.arguments,
              toolResult.slice(0, 500),
              Date.now() - toolStart,
              toolStatus
            );
          } catch { /* non-critical */ }

          messages.push({
            role: 'tool',
            content: toolResult,
            tool_call_id: toolCall.id,
          });

          this.emit('agent:toolCall', {
            type: 'tool_result',
            name: toolCall.function.name,
            result: toolResult,
          });
        }
        emptyCount = 0;
        // Loop continues — let the model decide what to do next
      } else if (msg.content?.trim()) {
        // No tool calls — this is the final response. Emit it and stop.
        // Filter out any raw JSON that leaked into the text (3B model quirk).
        const cleaned = msg.content
          .replace(/\{[\s\S]*?"name":\s*"fs_[^}]*\}/g, '')  // strip leaked tool JSON
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (cleaned) this.emit('agent:token', cleaned);
        break;
      } else {
        // Empty response — guard against infinite loop
        emptyCount++;
        if (emptyCount >= 3) break;
      }
    }

    db.prepare(`UPDATE agent_states SET status='completed', updated_at=unixepoch() WHERE workflow_id=?`)
      .run(plan.workflowId);

    this.activePlans.delete(plan.workflowId);
  }

  private getSessionHistory(sessionId: string): OpenAI.ChatCompletionMessageParam[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT sender_type, content FROM messages
      WHERE session_id = ? ORDER BY timestamp DESC LIMIT 20
    `).all(sessionId) as { sender_type: string; content: string }[];

    return rows.reverse().map(r => ({
      role: r.sender_type === 'user' ? 'user' : 'assistant',
      content: r.content,
    }));
  }

  private emit(channel: string, data?: unknown): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(channel, data);
    }
  }
}
