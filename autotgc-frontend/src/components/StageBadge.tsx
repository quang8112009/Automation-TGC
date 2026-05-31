/**
 * StageBadge — a colored badge for a candidate recruitment stage, showing the
 * Vietnamese label. Mirrors the StatusBadge in ui.tsx but uses the recruitment
 * stage palette + labels.
 */
import { CANDIDATE_STAGE_BADGE, candidateStageLabel } from '../lib/recruitment';
import type { CandidateStage } from '../lib/types';

export function StageBadge({ stage }: { stage: string }) {
  const cls = CANDIDATE_STAGE_BADGE[stage as CandidateStage] ?? 'badge-gray';
  return <span className={`badge ${cls}`}>{candidateStageLabel(stage)}</span>;
}
