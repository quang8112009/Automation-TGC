/**
 * AiGroundingBadge — shows how an AI result was produced. When `aiGenerated` is
 * true the text was phrased by the Gemini model; when false it is a
 * deterministic, knowledge-grounded answer assembled from the curated knowledge
 * base (no model call). The false case is a valid answer, NOT a failure — we
 * label it "Trả lời dựa trên cơ sở tri thức".
 */
export function AiGroundingBadge({ aiGenerated }: { aiGenerated: boolean }) {
  if (aiGenerated) {
    return (
      <span className="badge badge-green" title="Nội dung do mô hình AI (Gemini) tạo">
        AI tạo nội dung
      </span>
    );
  }
  return (
    <span
      className="badge badge-blue"
      title="Câu trả lời được tổng hợp từ cơ sở tri thức của công ty (không gọi mô hình AI)"
    >
      Trả lời dựa trên cơ sở tri thức
    </span>
  );
}
