/**
 * Assistant (/assistant, ADMIN + SALES) — a grounded chat assistant with
 * CONVERSATIONAL MEMORY and live STREAMING.
 *
 *  - Left: the user's own conversations (private per user) + a "New" button.
 *  - Right: the selected thread's messages, a live-streaming answer bubble, and
 *    a composer. Sending streams the answer token-by-token (SSE) and persists
 *    both turns server-side, so reopening a thread restores the history.
 *
 * AI-OPTIONAL: when no model is configured the answer is a deterministic
 * knowledge-grounded fallback (aiGenerated:false), rendered as a valid answer.
 * ADMIN additionally sees a "Reindex tri thức" action that recomputes semantic
 * embeddings for hybrid retrieval.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createConversation,
  getConversationMessages,
  listConversations,
  reindexKnowledge,
  streamAssistant,
  type AssistantStoredMessage,
} from '../api/assistant';
import { useAuth } from '../auth/AuthContext';
import { ErrorMessage, Loading, formatDate } from '../components/ui';
import { AiGroundingBadge } from '../components/AiGroundingBadge';
import { Icon } from '../components/Icon';
import { ApiError } from '../lib/apiClient';

export function Assistant() {
  const { role } = useAuth();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const convosQuery = useQuery({
    queryKey: ['assistant', 'conversations'],
    queryFn: listConversations,
  });

  const newConvoMutation = useMutation({
    mutationFn: () => createConversation(),
    onSuccess: (c) => {
      void queryClient.invalidateQueries({ queryKey: ['assistant', 'conversations'] });
      setSelectedId(c.id);
    },
  });

  const conversations = convosQuery.data?.conversations ?? [];

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Trợ lý AI</div>
          <h1 className="page-title">Trợ lý hội thoại</h1>
        </div>
        <div className="inline-list" style={{ alignItems: 'center' }}>
          {role === 'ADMIN' && <ReindexButton />}
          <button
            className="btn btn-primary"
            disabled={newConvoMutation.isPending}
            onClick={() => newConvoMutation.mutate()}
          >
            <Icon name="plus" size={16} />
            <span>Hội thoại mới</span>
          </button>
        </div>
      </div>

      <div className="split-2col" style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 'var(--space-lg)', alignItems: 'start' }}>
        {/* Left: conversation list */}
        <div className="card">
          <h2 className="card-title">Hội thoại của tôi</h2>
          {convosQuery.isLoading ? (
            <Loading label="Đang tải…" rows={3} />
          ) : conversations.length === 0 ? (
            <div className="muted">Chưa có hội thoại nào. Bấm "Hội thoại mới" để bắt đầu.</div>
          ) : (
            <div className="steps-list">
              {conversations.map((c) => (
                <button
                  key={c.id}
                  className={`step-row ${selectedId === c.id ? 'active' : ''}`}
                  style={{ width: '100%', textAlign: 'left', cursor: 'pointer', background: selectedId === c.id ? 'var(--surface-2, rgba(0,0,0,0.04))' : 'transparent', border: 'none' }}
                  onClick={() => setSelectedId(c.id)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.title ?? 'Hội thoại mới'}
                    </div>
                    <div className="muted" style={{ fontSize: '0.8em' }}>{formatDate(c.updatedAt)}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right: thread */}
        <div className="card">
          {selectedId == null ? (
            <div className="muted">Chọn một hội thoại bên trái, hoặc tạo hội thoại mới để hỏi trợ lý.</div>
          ) : (
            <ConversationThread conversationId={selectedId} />
          )}
        </div>
      </div>
    </div>
  );
}

/** ADMIN-only: recompute semantic embeddings for hybrid retrieval. */
function ReindexButton() {
  const mutation = useMutation({ mutationFn: reindexKnowledge });
  return (
    <button
      className="btn btn-sm"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
      title="Tính lại embedding cho tìm kiếm ngữ nghĩa"
    >
      <Icon name="sparkles" size={16} />
      <span>
        {mutation.isPending
          ? 'Đang lập chỉ mục…'
          : mutation.data
            ? `Đã lập chỉ mục (${mutation.data.updated}/${mutation.data.updated + mutation.data.skipped})`
            : 'Reindex tri thức'}
      </span>
    </button>
  );
}

interface LiveTurn {
  question: string;
  answer: string;
  aiGenerated: boolean | null; // null while streaming
}

function ConversationThread({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const messagesQuery = useQuery({
    queryKey: ['assistant', 'messages', conversationId],
    queryFn: () => getConversationMessages(conversationId),
  });
  const messages: AssistantStoredMessage[] = messagesQuery.data?.messages ?? [];

  // Auto-scroll to the newest content as it streams in.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, live?.answer]);

  // Cancel any in-flight stream when switching threads / unmounting.
  useEffect(() => {
    return () => abortRef.current?.();
  }, [conversationId]);

  function send() {
    const question = draft.trim();
    if (question.length === 0 || streaming) return;
    setError(null);
    setDraft('');
    setStreaming(true);
    setLive({ question, answer: '', aiGenerated: null });

    abortRef.current = streamAssistant(
      { question, conversationId },
      {
        onDelta: (text) => setLive((prev) => (prev ? { ...prev, answer: prev.answer + text } : prev)),
        onDone: (done) => {
          setStreaming(false);
          setLive(null);
          // Server persisted both turns — reload the thread + bump list order.
          void queryClient.invalidateQueries({ queryKey: ['assistant', 'messages', conversationId] });
          void queryClient.invalidateQueries({ queryKey: ['assistant', 'conversations'] });
          void done;
        },
        onError: (err) => {
          setStreaming(false);
          setLive(null);
          setError(err);
        },
      },
    );
  }

  return (
    <div>
      {messagesQuery.isLoading ? (
        <Loading label="Đang tải hội thoại…" rows={3} />
      ) : (
        <div className="chat-thread" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', maxHeight: '52vh', overflowY: 'auto', paddingRight: 'var(--space-xs)' }}>
          {messages.length === 0 && live == null && (
            <div className="muted">Hãy đặt câu hỏi đầu tiên cho trợ lý.</div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} role={m.role} content={m.content} aiGenerated={m.role === 'ASSISTANT' ? m.aiGenerated : undefined} />
          ))}
          {live != null && (
            <>
              <MessageBubble role="USER" content={live.question} />
              <MessageBubble role="ASSISTANT" content={live.answer || '…'} streaming={streaming} aiGenerated={live.aiGenerated ?? undefined} />
            </>
          )}
          <div ref={bottomRef} />
        </div>
      )}

      {error != null && <ErrorMessage error={error} />}

      <div className="field" style={{ marginTop: 'var(--space-md)' }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Nhập câu hỏi… (Ctrl/Cmd + Enter để gửi)"
          disabled={streaming}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
          }}
        />
      </div>
      <button className="btn btn-primary" disabled={streaming || draft.trim().length === 0} onClick={send}>
        <Icon name="send" size={16} />
        <span>{streaming ? 'Đang trả lời…' : 'Gửi'}</span>
      </button>
    </div>
  );
}

function MessageBubble({
  role,
  content,
  aiGenerated,
  streaming,
}: {
  role: 'USER' | 'ASSISTANT';
  content: string;
  aiGenerated?: boolean;
  streaming?: boolean;
}) {
  const isUser = role === 'USER';
  return (
    <div
      className={`chat-bubble chat-bubble--${isUser ? 'user' : 'assistant'}`}
      style={{
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '85%',
        background: isUser ? 'var(--brand-soft, rgba(0,90,200,0.08))' : 'var(--surface-2, rgba(0,0,0,0.04))',
        borderRadius: 'var(--radius-md, 10px)',
        padding: 'var(--space-sm) var(--space-md)',
      }}
    >
      <div className="inline-list" style={{ alignItems: 'center', gap: 'var(--space-xs)', marginBottom: 4 }}>
        <strong style={{ fontSize: '0.8em' }}>{isUser ? 'Bạn' : 'Trợ lý'}</strong>
        {!isUser && aiGenerated !== undefined && <AiGroundingBadge aiGenerated={aiGenerated} />}
        {streaming && <span className="muted" style={{ fontSize: '0.8em' }}>đang gõ…</span>}
      </div>
      <div style={{ whiteSpace: 'pre-wrap' }}>{content}</div>
    </div>
  );
}
