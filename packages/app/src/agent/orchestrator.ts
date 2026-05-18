/**
 * Agent Orchestrator — ReAct (Reason + Act) loop.
 *
 * Inspired by OpenHands' CodeAct pattern.
 * Takes a user message, builds a plan (planning mode), then executes
 * each step by calling LLM + MCP tools, observing outputs, and
 * self-correcting on failure.
 */
import { BrowserWindow } from 'electron';
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

    db.prepare(`UPDATE agent_states SET status='running' WHERE workflow_id=?`)
      .run(plan.workflowId);

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are Artha, a local AI agent running on the user's Mac. You have real filesystem tools available.

CRITICAL RULES:
1. You MUST call tools to complete tasks. Never say you've done something without calling a tool first.
2. Never describe what you "would" do — actually DO it by calling the tools.
3. For file organisation tasks: first call fs_list_directory or fs_search_files, then call fs_move_file for each file.
4. After completing all tool calls, give a brief summary of what was actually done.

Current plan: ${JSON.stringify(plan.steps.map(s => s.description))}
Goal: ${plan.goal}

The user's home directory is at ~/. The Desktop is at ~/Desktop.`,
      },
      { role: 'user', content: plan.goal },
    ];

    let stepsDone = 0;
    let retries = 0;

    while (stepsDone < plan.steps.length && stepsDone < MAX_STEPS) {
      const step = plan.steps[stepsDone];
      step.status = 'running';
      this.emit('agent:toolCall', { type: 'step_start', step });

      try {
        const response = await llm.complete(messages, tools);
        const msg = response.choices[0]?.message;

        if (!msg) break;

        messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

        // Handle tool calls
        if (msg.tool_calls?.length) {
          for (const toolCall of msg.tool_calls) {
            this.emit('agent:toolCall', { type: 'tool_invoke', name: toolCall.function.name, args: toolCall.function.arguments });
            
            let toolResult: string;
            try {
              toolResult = await this.registry.invokeTool(
                toolCall.function.name,
                JSON.parse(toolCall.function.arguments)
              );
            } catch (err) {
              toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }

            messages.push({
              role: 'tool',
              content: toolResult,
              tool_call_id: toolCall.id,
            });

            this.emit('agent:toolCall', { type: 'tool_result', name: toolCall.function.name, result: toolResult });
          }
          retries = 0;
        } else if (msg.content) {
          // LLM produced a text response — stream it
          this.emit('agent:token', msg.content);
          step.output = msg.content;
          step.status = 'done';
          stepsDone++;
          retries = 0;
        } else {
          // Empty response — retry
          retries++;
          if (retries >= MAX_RETRIES) {
            step.status = 'failed';
            step.error = 'Max retries reached on empty response';
            stepsDone++;
          }
        }
      } catch (err) {
        step.status = 'failed';
        step.error = err instanceof Error ? err.message : String(err);
        this.emit('agent:token', `\n\n⚠️ Step ${stepsDone + 1} failed: ${step.error}. Attempting self-correction...\n`);
        retries++;
        if (retries >= MAX_RETRIES) {
          stepsDone++;
          retries = 0;
        }
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
