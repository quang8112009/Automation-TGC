/**
 * Tests for the outbound AI-gateway timeout (Trợ lý Công việc TGC fix).
 *
 * Root cause this guards against: the text-gateway call used `fetch` with NO
 * timeout, so a slow/hanging gateway made the assistant request hang until the
 * nginx `proxy_read_timeout` cut it (the user-visible "timeout"). The fix gives
 * `GeminiClient` a default request deadline (via AbortController in
 * `createFetchHttpClient`) so a hang surfaces as a rejected fetch -> a clean 502
 * AI_REQUEST_FAILED -> the consultant agent's deterministic grounded fallback.
 *
 * These tests use fake timers so no real time elapses.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFetchHttpClient } from '../src/platforms/httpClient';
import { AiTextClient } from '../src/infra/aiTextClient';
import type { AiTextConfig } from '../src/infra/aiTextConfig';

/** Build an AiTextConfig pointing at the test gateway with a short timeout. */
const testConfig = (timeout = 30): AiTextConfig => ({
  provider: 'deepseek',
  baseUrl: 'https://gateway.test/v1',
  model: 'deepseek-v4-flash',
  timeout,
});
import { RecruitmentConsultantAgent } from '../src/recruitment/agent/consultantAgent';
import type { KnowledgeService } from '../src/recruitment/knowledge/knowledgeService';
import type { KnowledgeEntry } from '@prisma/client';
import { AppError } from '../src/infra/errors';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A fetch impl that NEVER resolves on its own — only an abort signal ends it. */
function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }
    })) as unknown as typeof fetch;
}

/** A KnowledgeService stub returning a fixed grounding row. */
function fakeKnowledge(rows: KnowledgeEntry[]): KnowledgeService {
  return {
    search: async () => rows,
    list: async () => rows,
  } as unknown as KnowledgeService;
}

function knowledgeRow(): KnowledgeEntry {
  return {
    id: 'kb-1',
    category: 'faq',
    title: 'Điều kiện tham gia',
    content: 'Thông tin nền mẫu.',
    tags: [],
    market: null,
    active: true,
    createdAt: new Date('2025-06-01T00:00:00.000Z'),
    updatedAt: new Date('2025-06-01T00:00:00.000Z'),
  } as KnowledgeEntry;
}

describe('createFetchHttpClient default timeout', () => {
  it('aborts a hanging request after the default timeout', async () => {
    vi.useFakeTimers();
    const http = createFetchHttpClient(hangingFetch(), 50);

    const pending = http.post('https://gateway.test/v1/chat/completions', { x: 1 });
    const assertion = expect(pending).rejects.toBeInstanceOf(DOMException);

    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it('does NOT abort when no timeout is configured (historic behavior)', async () => {
    vi.useFakeTimers();
    let resolved = false;
    const http = createFetchHttpClient(hangingFetch()); // no default timeout

    void http.post('https://gateway.test/v1/chat/completions', { x: 1 }).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolved).toBe(false);
  });

  it('a per-request timeoutMs overrides the factory default', async () => {
    vi.useFakeTimers();
    const http = createFetchHttpClient(hangingFetch(), 10_000);

    const pending = http.post('https://gateway.test/v1/chat/completions', { x: 1 }, { timeoutMs: 25 });
    const assertion = expect(pending).rejects.toBeInstanceOf(DOMException);

    await vi.advanceTimersByTimeAsync(30);
    await assertion;
  });
});

describe('GeminiClient timeout -> 502 (no hang)', () => {
  it('rejects with AI_REQUEST_FAILED when the gateway hangs past the timeout', async () => {
    vi.useFakeTimers();
    // Stub the global fetch BEFORE constructing the client so its default
    // createFetchHttpClient picks up the hanging impl.
    vi.stubGlobal('fetch', hangingFetch());
    const client = new AiTextClient('test-key', testConfig(30), undefined);

    const pending = client.generateContent('xin chào');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' });
    await vi.advanceTimersByTimeAsync(40);
    await assertion;
  });
});

describe('consult() falls back to a grounded answer when the gateway times out', () => {
  it('returns aiGenerated:false (not a hang/throw) on a Gemini timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());

    const gemini = new AiTextClient('test-key', testConfig(30), undefined);
    const agent = new RecruitmentConsultantAgent(fakeKnowledge([knowledgeRow()]), gemini);

    const resultPromise = agent.consult('điều kiện tham gia là gì?');
    // Let the abort fire and the fallback assemble.
    await vi.advanceTimersByTimeAsync(40);
    const result = await resultPromise;

    expect(result.aiGenerated).toBe(false);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.answer.length).toBeGreaterThan(0);
  });
});

describe('GeminiClient still fails fast when unconfigured', () => {
  it('throws AI_NOT_CONFIGURED without any HTTP call', async () => {
    const client = new AiTextClient(undefined, testConfig());
    await expect(client.generateContent('hi')).rejects.toBeInstanceOf(AppError);
  });
});
