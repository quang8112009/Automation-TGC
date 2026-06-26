/**
 * Typed wrappers for the GROUNDED ASSISTANT (with conversational memory +
 * streaming). Backend: `/api/v1/assistant/*` (ADMIN + SALES via dashboard/read;
 * reindex is ADMIN-only). The assistant is AI-OPTIONAL: when no model is
 * configured the answer is a deterministic, knowledge-grounded fallback flagged
 * `aiGenerated: false` — render it as a valid answer, not a failure.
 *
 * The streaming helper mirrors the proven SSE consumer in `api/marketing.ts`:
 * it POSTs to the stream endpoint, parses `delta` / `done` frames, and returns
 * an abort function. A pre-stream failure (400/401) comes back as a normal JSON
 * envelope, surfaced via `onError`.
 */
import { api } from '../lib/apiClient';
import { apiUrl } from '../lib/config';
import { getAccessToken } from '../lib/storage';
import { ApiError } from '../lib/apiClient';
import { parseSseFrames, type SseFrame } from '../lib/sse';

export interface AssistantConversationSummary {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantStoredMessage {
  id: string;
  role: 'USER' | 'ASSISTANT';
  content: string;
  aiGenerated: boolean;
  createdAt: string;
}

export interface AssistantToolResult {
  ok: boolean;
  name: string;
  [key: string]: unknown;
}

/** The buffered /ask response shape. */
export interface AssistantAnswer {
  answer: string;
  aiGenerated: boolean;
  iterations: number;
  toolResults: AssistantToolResult[];
  fallbackReason?: string;
  conversationId: string | null;
}

export interface ReindexResult {
  updated: number;
  skipped: number;
  embedderConfigured: boolean;
}

// ---- Conversation memory ---------------------------------------------------

export function createConversation(title?: string): Promise<AssistantConversationSummary> {
  return api.post<AssistantConversationSummary>('/api/v1/assistant/conversations', { title });
}

export function listConversations(): Promise<{ conversations: AssistantConversationSummary[] }> {
  return api.get<{ conversations: AssistantConversationSummary[] }>('/api/v1/assistant/conversations');
}

export function getConversationMessages(id: string): Promise<{ messages: AssistantStoredMessage[] }> {
  return api.get<{ messages: AssistantStoredMessage[] }>(
    `/api/v1/assistant/conversations/${encodeURIComponent(id)}/messages`,
  );
}

// ---- Ask (buffered) --------------------------------------------------------

export function askAssistant(question: string, conversationId?: string): Promise<AssistantAnswer> {
  return api.post<AssistantAnswer>('/api/v1/assistant/ask', { question, conversationId });
}

// ---- Knowledge reindex (ADMIN) --------------------------------------------

export function reindexKnowledge(): Promise<ReindexResult> {
  return api.post<ReindexResult>('/api/v1/assistant/knowledge/reindex');
}

// ---- Ask (streaming SSE) ---------------------------------------------------

export interface AssistantStreamDone {
  aiGenerated: boolean;
  conversationId: string | null;
}

export interface AssistantStreamHandlers {
  /** Each user-facing text chunk as it arrives. */
  onDelta: (text: string) => void;
  /** Once, when the stream completes (carries the aiGenerated flag). */
  onDone: (done: AssistantStreamDone) => void;
  /** A pre-stream envelope (400/401) or an interrupted stream. */
  onError: (err: ApiError) => void;
}

/** A parsed assistant stream event (or null for frames we ignore). */
export type AssistantStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; done: AssistantStreamDone }
  | null;

/**
 * Pure interpretation of one SSE frame into an assistant stream event. Tolerant
 * by design: a malformed `delta` payload (or any unknown event) yields `null`,
 * and a malformed `done` payload degrades to a non-AI completion rather than
 * throwing. Exported for unit/property testing.
 */
export function interpretAssistantFrame(frame: SseFrame): AssistantStreamEvent {
  if (frame.event === 'delta') {
    try {
      const parsed = JSON.parse(frame.data) as { text?: unknown };
      if (typeof parsed.text === 'string') return { type: 'delta', text: parsed.text };
    } catch {
      /* ignore malformed delta */
    }
    return null;
  }
  if (frame.event === 'done') {
    try {
      const parsed = JSON.parse(frame.data) as Partial<AssistantStreamDone>;
      return {
        type: 'done',
        done: {
          aiGenerated: parsed.aiGenerated === true,
          conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : null,
        },
      };
    } catch {
      return { type: 'done', done: { aiGenerated: false, conversationId: null } };
    }
  }
  return null;
}

/**
 * Stream a grounded answer over SSE. Returns an abort function (call on unmount
 * or to cancel). Auth is the stored Bearer token; a 401 surfaces via onError
 * (the stream path does not silently refresh like the JSON client).
 */
export function streamAssistant(
  input: { question: string; conversationId?: string },
  handlers: AssistantStreamHandlers,
): () => void {
  const controller = new AbortController();

  void (async () => {
    let res: Response;
    try {
      const token = getAccessToken();
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      res = await fetch(apiUrl('/api/v1/assistant/ask/stream'), {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
        signal: controller.signal,
      });
    } catch {
      handlers.onError(new ApiError(0, 'NETWORK_ERROR', 'Không kết nối được máy chủ'));
      return;
    }

    // Pre-stream failure (validation 400, auth 401, ownership 404) → JSON envelope.
    if (!res.ok || !res.body) {
      let code = 'ASSISTANT_FAILED';
      let message = res.statusText || 'Trợ lý gặp lỗi';
      try {
        const data = (await res.json()) as { error?: { code?: string; message?: string } };
        if (data.error) {
          code = data.error.code ?? code;
          message = data.error.message ?? message;
        }
      } catch {
        /* keep defaults */
      }
      handlers.onError(new ApiError(res.status, code, message));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    const handleFrame = (frame: SseFrame): void => {
      const event = interpretAssistantFrame(frame);
      if (event === null) return;
      if (event.type === 'delta') handlers.onDelta(event.text);
      else handlers.onDone(event.done);
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSseFrames(buffer);
        buffer = rest;
        for (const frame of frames) handleFrame(frame);
      }
      // Flush any complete frame left in the buffer after the stream ends.
      const { frames } = parseSseFrames(buffer.endsWith('\n\n') ? buffer : `${buffer}\n\n`);
      for (const frame of frames) handleFrame(frame);
    } catch {
      if (!controller.signal.aborted) {
        handlers.onError(new ApiError(0, 'STREAM_INTERRUPTED', 'Luồng trả lời bị gián đoạn'));
      }
    }
  })();

  return () => controller.abort();
}
