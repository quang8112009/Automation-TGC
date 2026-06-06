/**
 * PersonaPicker — a dropdown of saved personas that appends the chosen persona's
 * id to a comma-separated "Persona IDs" string field.
 *
 * Personas live in the database (ContentPersona.id) and are listed via
 * GET /api/strategy/personas. The content-generation surfaces (Content Studio,
 * Content Plans, Drafts, Autopilot, Workflows) take persona ids as a
 * comma-separated string; this control lets the user pick by name instead of
 * hand-typing UUIDs (which previously were not even surfaced in the UI).
 *
 * Controlled: the parent owns the `value` string and `onChange`. Selecting an
 * option appends its id (de-duplicated) and resets the select.
 */
import { useQuery } from '@tanstack/react-query';
import { listPersonas } from '../api/strategy';

export interface PersonaPickerProps {
  /** The current comma-separated persona-ids string. */
  value: string;
  /** Called with the next comma-separated string after a pick. */
  onChange: (next: string) => void;
}

/** Append an id to a comma-separated list, ignoring blanks/duplicates. */
export function appendPersonaId(current: string, id: string): string {
  if (!id) return current;
  const ids = current
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.includes(id)) return current;
  return [...ids, id].join(', ');
}

export function PersonaPicker({ value, onChange }: PersonaPickerProps) {
  const personasQuery = useQuery({
    queryKey: ['strategy', 'personas'],
    queryFn: () => listPersonas(),
  });
  const options = personasQuery.data?.items ?? [];

  if (personasQuery.isLoading) {
    return (
      <div className="muted" style={{ marginTop: 'var(--space-xs)', fontSize: 'var(--fs-xs)' }}>
        Đang tải danh sách persona…
      </div>
    );
  }
  if (options.length === 0) {
    return (
      <div className="muted" style={{ marginTop: 'var(--space-xs)', fontSize: 'var(--fs-xs)' }}>
        Chưa có persona nào. Tạo persona ở mục Strategy &amp; Personas trước.
      </div>
    );
  }

  return (
    <select
      value=""
      onChange={(e) => {
        onChange(appendPersonaId(value, e.target.value));
        e.target.value = '';
      }}
      style={{ marginTop: 'var(--space-xs)' }}
      aria-label="Chọn persona đã lưu để thêm"
    >
      <option value="">+ Chọn persona đã lưu để thêm…</option>
      {options.map((p) => (
        <option key={p.id} value={p.id}>
          {p.personaName} · {p.domainName}
        </option>
      ))}
    </select>
  );
}
