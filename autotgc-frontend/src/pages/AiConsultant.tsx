/**
 * AiConsultant (/ai-consultant, ADMIN) — a free-form Q&A box for the AI
 * recruitment consultant. Calls POST /api/v1/ai/consult and shows the answer,
 * the knowledge sources it was grounded on, and an `aiGenerated` indicator.
 *
 * The consult endpoint never 502s when AI is unconfigured: it returns a
 * deterministic, knowledge-grounded answer (aiGenerated: false). We render that
 * as a valid answer labeled "Trả lời dựa trên cơ sở tri thức", not a failure.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { aiConsult } from '../api/aiConsultant';
import { ErrorMessage } from '../components/ui';
import { AiGroundingBadge } from '../components/AiGroundingBadge';
import type { AiConsultResult } from '../lib/types';

export function AiConsultant() {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AiConsultResult | null>(null);

  const mutation = useMutation({
    mutationFn: () => aiConsult(question.trim()),
    onSuccess: (data) => setResult(data),
  });

  function submit() {
    if (question.trim().length === 0) return;
    setResult(null);
    mutation.mutate();
  }

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Marketing AI</div>
          <h1 className="page-title">Trợ lý Công việc TGC</h1>
        </div>
      </div>

      <div className="card">
        <div className="muted" style={{ marginBottom: 12 }}>
          Đặt câu hỏi về xuất khẩu lao động (thị trường, diện visa, ngành nghề, quy trình, chi
          phí…). Câu trả lời được tổng hợp từ cơ sở tri thức của công ty; khi AI được cấu hình, nội
          dung sẽ do mô hình diễn đạt lại.
        </div>
        <div className="field">
          <label>Câu hỏi</label>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="VD: Điều kiện tham gia đơn hàng kỹ năng đặc định ngành điều dưỡng là gì?"
          />
        </div>
        <button
          className="btn btn-primary"
          disabled={mutation.isPending || question.trim().length === 0}
          onClick={submit}
        >
          {mutation.isPending ? 'Đang tư vấn…' : 'Gửi câu hỏi'}
        </button>
      </div>

      {mutation.error != null && <ErrorMessage error={mutation.error} />}

      {result != null && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <h2 className="card-title" style={{ margin: 0 }}>
              Câu trả lời
            </h2>
            <AiGroundingBadge aiGenerated={result.aiGenerated} />
          </div>
          <pre className="code" style={{ whiteSpace: 'pre-wrap' }}>
            {result.answer}
          </pre>

          <h3 style={{ marginTop: 18 }}>
            Nguồn tham khảo từ cơ sở tri thức ({result.sources.length})
          </h3>
          {result.sources.length === 0 ? (
            <div className="muted">
              Không tìm thấy nội dung nền phù hợp. Hãy bổ sung cơ sở tri thức hoặc liên hệ tư vấn
              trực tiếp.
            </div>
          ) : (
            <div className="steps-list">
              {result.sources.map((s) => (
                <div key={s.id} className="step-row" style={{ alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div>
                      <span className="badge badge-gray">{s.category}</span>{' '}
                      <strong>{s.title}</strong>
                    </div>
                    <div className="muted" style={{ marginTop: 4 }}>
                      {s.content}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
