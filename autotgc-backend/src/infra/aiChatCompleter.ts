/**
 * AiTextChatCompleter — a real `ChatCompleter` over the OpenAI-COMPATIBLE
 * gateway (DeepSeek V4), the adapter that lets `runAgentLoop` drive a
 * tool-using conversation. This is the piece that "activates" the agentic loop
 * against the live provider.
 *
 * Design (keeps the system safe):
 *  - Implements the injected-seam `ChatCompleter` so `runAgentLoop` stays pure
 *    orchestration; HTTP is injected for testing.
 *  - Offers ONLY the tool schemas whose name is in the `toolNames` the loop
 *    passes (which come from the allow-list `ToolRegistry`) — the model can
 *    never be offered a tool the registry does not govern.
 *  - Parses the gateway response into a `ChatTurn`: `tool_calls` (via the pure
 *    `parseToolCalls`) take precedence; otherwise the assistant text (via the
 *    pure `extractText`). An empty/garbled response surfaces as a thrown
 *    AppError, which the loop converts into a COMPLETER_ERROR (deterministic
 *    fallback downstream — AI-OPTIONAL spirit).
 *  - Transcript translation: our loop records tool results as `role:'tool'`
 *    messages. To stay robust across gateways (and avoid the strict OpenAI
 *    assistant/tool_call_id pairing requirement), those are sent as a framed
 *    `role:'user'` message (`[Tool <name> result] <content>`). No secret is
 *    ever placed in the request beyond the Bearer auth header.
 */
import { AppError } from './errors';
import { createFetchHttpClient } from '../platforms/httpClient';
import type { HttpClient } from '../platforms/httpClient';
import type { AiTextConfig } from './aiTextConfig';
import { extractText } from './aiTextClient';
import { parseToolCalls } from './aiToolCalls';
import type { ChatCompleter, ChatMessage, ChatTurn } from './aiAgentLoop';

/** JSON-schema-ish description of one tool the model may call. */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema object for the tool's arguments (OpenAI `function.parameters`). */
  parameters: Record<string, unknown>;
}

/** OpenAI chat message shape sent to the gateway. */
interface WireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Translate a loop ChatMessage into a wire message (tool → framed user). */
function toWireMessage(m: ChatMessage): WireMessage {
  if (m.role === 'tool') {
    const label = m.name ? `[Tool ${m.name} result] ` : '[Tool result] ';
    return { role: 'user', content: `${label}${m.content}` };
  }
  return { role: m.role, content: m.content };
}

/** Build the OpenAI `tools` array from the schemas whose name is allowed. */
function buildToolsParam(schemas: readonly ToolSchema[], allowed: readonly string[]): unknown[] | undefined {
  const allowedSet = new Set(allowed);
  const offered = schemas.filter((s) => allowedSet.has(s.name));
  if (offered.length === 0) return undefined;
  return offered.map((s) => ({
    type: 'function',
    function: { name: s.name, description: s.description, parameters: s.parameters },
  }));
}

export class AiTextChatCompleter implements ChatCompleter {
  private readonly http: HttpClient;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly config: AiTextConfig,
    /** Full schemas for every tool that MAY be offered (filtered per call). */
    private readonly toolSchemas: readonly ToolSchema[] = [],
    httpClient?: HttpClient,
  ) {
    this.http = httpClient ?? createFetchHttpClient(undefined, this.config.timeout);
  }

  async complete(messages: readonly ChatMessage[], toolNames: readonly string[]): Promise<ChatTurn> {
    if (!this.apiKey || this.apiKey.trim().length === 0 || this.config.baseUrl.trim().length === 0) {
      throw new AppError(502, 'AI not configured', 'AI_NOT_CONFIGURED');
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map(toWireMessage),
    };
    const tools = buildToolsParam(this.toolSchemas, toolNames);
    if (tools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    let res;
    try {
      res = await this.http.post(`${this.config.baseUrl}/chat/completions`, body, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        timeoutMs: this.config.timeout,
      });
    } catch {
      throw new AppError(502, 'AI request failed', 'AI_REQUEST_FAILED');
    }
    if (!res.ok) {
      throw new AppError(502, 'AI request failed', 'AI_REQUEST_FAILED');
    }

    return this.toTurn(res.body);
  }

  /**
   * Convert a gateway response body into a ChatTurn. Tool calls take precedence
   * over text. If neither is present, throw AI_BAD_RESPONSE so the loop records
   * a COMPLETER_ERROR and the caller falls back deterministically.
   */
  private toTurn(body: unknown): ChatTurn {
    const toolCalls = parseToolCalls(body);
    if (toolCalls.length > 0) {
      return { kind: 'tool_calls', toolCalls };
    }
    const text = extractText(body);
    if (text !== undefined) {
      return { kind: 'text', content: text };
    }
    throw new AppError(502, 'AI returned no content', 'AI_BAD_RESPONSE');
  }
}
