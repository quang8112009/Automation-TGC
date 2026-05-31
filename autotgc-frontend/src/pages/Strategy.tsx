/**
 * Strategy & Personas — create/edit personas, fetch AI recommendations, and a
 * simple calendar (month/week/day list) with reschedule.
 *
 * Endpoints: POST /api/strategy/persona, PUT /api/strategy/persona/:id,
 * GET /api/strategy/persona/:id/recommendations, GET /api/strategy/calendar,
 * PUT /api/strategy/calendar/:id/reschedule, GET /api/strategy/ai-context.
 *
 * Note: there is no "list personas" backend endpoint, so personas created in
 * this session are tracked locally to allow editing right after creation. AI
 * recommendations may return 502 when Gemini is not configured — surfaced
 * cleanly.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createPersona,
  getAiContext,
  getCalendar,
  getRecommendations,
  rescheduleCalendarItem,
  updatePersona,
} from '../api/strategy';
import type { PersonaInput } from '../api/strategy';
import {
  ErrorMessage,
  Loading,
  Modal,
  StatusBadge,
  SuccessMessage,
  formatDate,
} from '../components/ui';
import { Icon } from '../components/Icon';
import type { ContentPersona } from '../lib/types';

type CalendarView = 'month' | 'week' | 'day';

const EMPTY_PERSONA: PersonaInput = {
  domainName: '',
  personaName: '',
  age: '',
  interests: '',
  targetNeeds: '',
  painPoints: '',
  toneOfVoice: '',
};

export function Strategy() {
  const queryClient = useQueryClient();
  const [sessionPersonas, setSessionPersonas] = useState<ContentPersona[]>([]);
  const [editing, setEditing] = useState<ContentPersona | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [recoDomain, setRecoDomain] = useState('');
  const [reco, setReco] = useState<PersonaInput | null>(null);

  const recommendMutation = useMutation({
    mutationFn: (domain: string) => getRecommendations(domain),
    onSuccess: (data) => {
      setReco({ ...EMPTY_PERSONA, domainName: recoDomain, ...data });
    },
  });

  const aiContextQuery = useQuery({
    queryKey: ['strategy', 'aiContext'],
    queryFn: getAiContext,
  });

  function onPersonaSaved(p: ContentPersona) {
    setSessionPersonas((prev) => {
      const idx = prev.findIndex((x) => x.id === p.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = p;
        return next;
      }
      return [p, ...prev];
    });
    setShowForm(false);
    setEditing(null);
    setReco(null);
    void queryClient.invalidateQueries({ queryKey: ['calendar'] });
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Strategy &amp; Personas</h1>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => {
            setEditing(null);
            setReco(null);
            setShowForm(true);
          }}
        >
          <Icon name="plus" size={16} />
          New Persona
        </button>
      </div>

      <div className="grid grid-2">
        {/* AI Recommendation */}
        <div className="card">
          <h2 className="card-title">AI Persona Recommendation</h2>
          <p className="muted">
            Ask the AI to propose a persona for a domain. Returns a draft you can edit
            and save.
          </p>
          <div className="toolbar">
            <div className="field" style={{ flex: 1 }}>
              <label>Domain name</label>
              <input
                value={recoDomain}
                onChange={(e) => setRecoDomain(e.target.value)}
                placeholder="e.g. organic-skincare"
              />
            </div>
            <button
              className="btn btn-primary"
              disabled={!recoDomain || recommendMutation.isPending}
              onClick={() => recommendMutation.mutate(recoDomain)}
            >
              {recommendMutation.isPending ? 'Asking…' : 'Get recommendation'}
            </button>
          </div>
          {recommendMutation.error != null && <ErrorMessage error={recommendMutation.error} />}
          {reco && (
            <div className="success-box">
              Recommendation ready.{' '}
              <button
                className="btn btn-sm"
                onClick={() => {
                  setEditing(null);
                  setShowForm(true);
                }}
              >
                Review &amp; save
              </button>
            </div>
          )}
        </div>

        {/* AI Context read model */}
        <div className="card">
          <h2 className="card-title">AI Prompt Context</h2>
          {aiContextQuery.isLoading ? (
            <Loading />
          ) : aiContextQuery.error ? (
            <ErrorMessage error={aiContextQuery.error} />
          ) : (
            <pre className="code">{JSON.stringify(aiContextQuery.data ?? {}, null, 2)}</pre>
          )}
        </div>
      </div>

      {/* Personas created this session */}
      <div className="card">
        <h2 className="card-title">Personas (this session)</h2>
        <p className="muted">
          The backend has no list endpoint for personas; this shows personas created or
          edited during the current session.
        </p>
        {sessionPersonas.length === 0 ? (
          <div className="muted">No personas created yet in this session.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Age</th>
                  <th>Tone</th>
                  <th>Needs</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sessionPersonas.map((p) => (
                  <tr key={p.id}>
                    <td>{p.personaName}</td>
                    <td>{p.age}</td>
                    <td>{p.toneOfVoice}</td>
                    <td>{p.targetNeeds}</td>
                    <td>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setEditing(p);
                          setReco(null);
                          setShowForm(true);
                        }}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CalendarSection />

      {showForm && (
        <PersonaFormModal
          existing={editing}
          initial={reco}
          onClose={() => {
            setShowForm(false);
            setEditing(null);
          }}
          onSaved={onPersonaSaved}
        />
      )}
    </div>
  );
}

function PersonaFormModal({
  existing,
  initial,
  onClose,
  onSaved,
}: {
  existing: ContentPersona | null;
  initial: PersonaInput | null;
  onClose: () => void;
  onSaved: (p: ContentPersona) => void;
}) {
  const [form, setForm] = useState<PersonaInput>(() => {
    if (existing) {
      return {
        domainName: '',
        personaName: existing.personaName,
        age: existing.age,
        interests: existing.interests,
        targetNeeds: existing.targetNeeds,
        painPoints: existing.painPoints,
        toneOfVoice: existing.toneOfVoice,
      };
    }
    return initial ?? EMPTY_PERSONA;
  });

  const mutation = useMutation({
    mutationFn: () => {
      if (existing) {
        const { domainName: _ignored, ...rest } = form;
        void _ignored;
        return updatePersona(existing.id, rest);
      }
      return createPersona(form);
    },
    onSuccess: (p) => onSaved(p),
  });

  function set<K extends keyof PersonaInput>(key: K, value: PersonaInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <Modal title={existing ? 'Edit Persona' : 'New Persona'} onClose={onClose}>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {!existing && (
        <div className="field">
          <label>Domain name *</label>
          <input value={form.domainName ?? ''} onChange={(e) => set('domainName', e.target.value)} />
        </div>
      )}
      <div className="field">
        <label>Persona name</label>
        <input value={form.personaName ?? ''} onChange={(e) => set('personaName', e.target.value)} />
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label>Age *</label>
          <input value={form.age ?? ''} onChange={(e) => set('age', e.target.value)} />
        </div>
        <div className="field">
          <label>Tone of voice *</label>
          <input value={form.toneOfVoice ?? ''} onChange={(e) => set('toneOfVoice', e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>Interests</label>
        <input value={form.interests ?? ''} onChange={(e) => set('interests', e.target.value)} />
      </div>
      <div className="field">
        <label>Target needs *</label>
        <textarea value={form.targetNeeds ?? ''} onChange={(e) => set('targetNeeds', e.target.value)} />
      </div>
      <div className="field">
        <label>Pain points *</label>
        <textarea value={form.painPoints ?? ''} onChange={(e) => set('painPoints', e.target.value)} />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Saving…' : existing ? 'Save' : 'Create'}
        </button>
      </div>
    </Modal>
  );
}

function CalendarSection() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<CalendarView>('month');
  const [date, setDate] = useState('');
  const [rescheduleId, setRescheduleId] = useState<string | null>(null);
  const [rescheduleAt, setRescheduleAt] = useState('');
  const [rescheduleMsg, setRescheduleMsg] = useState<string | null>(null);

  const calendarQuery = useQuery({
    queryKey: ['calendar', view, date],
    queryFn: () => getCalendar(view, date || undefined),
  });

  const rescheduleMutation = useMutation({
    mutationFn: (args: { id: string; at: string }) =>
      rescheduleCalendarItem(args.id, new Date(args.at).toISOString()),
    onSuccess: () => {
      setRescheduleMsg('Rescheduled successfully.');
      setRescheduleId(null);
      setRescheduleAt('');
      void queryClient.invalidateQueries({ queryKey: ['calendar'] });
    },
  });

  return (
    <div className="card">
      <h2 className="card-title">Content Calendar</h2>
      <div className="toolbar">
        <div className="field">
          <label>View</label>
          <select value={view} onChange={(e) => setView(e.target.value as CalendarView)}>
            <option value="month">Month</option>
            <option value="week">Week</option>
            <option value="day">Day</option>
          </select>
        </div>
        <div className="field">
          <label>Anchor date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>

      {rescheduleMsg && <SuccessMessage>{rescheduleMsg}</SuccessMessage>}

      {calendarQuery.isLoading ? (
        <Loading />
      ) : calendarQuery.error ? (
        <ErrorMessage error={calendarQuery.error} />
      ) : calendarQuery.data ? (
        <>
          {calendarQuery.data.unavailable.length > 0 && (
            <div className="notice">
              Some sources were unavailable: {calendarQuery.data.unavailable.join(', ')}
            </div>
          )}
          <div className="grid grid-2">
            <div>
              <h3>Drafts ({calendarQuery.data.drafts.length})</h3>
              {calendarQuery.data.drafts.length === 0 ? (
                <div className="muted">No drafts in this window.</div>
              ) : (
                <ul>
                  {calendarQuery.data.drafts.map((d) => (
                    <li key={d.id}>
                      <span
                        className="conn-dot"
                        style={{ background: d.color, display: 'inline-block', marginRight: 6 }}
                      />
                      {d.title} <StatusBadge status={d.status} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3>Scheduled Posts ({calendarQuery.data.scheduledPosts.length})</h3>
              {calendarQuery.data.scheduledPosts.length === 0 ? (
                <div className="muted">No scheduled posts in this window.</div>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Platform</th>
                        <th>When</th>
                        <th>Status</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {calendarQuery.data.scheduledPosts.map((p) => (
                        <tr key={p.id}>
                          <td>{p.platformLabel}</td>
                          <td>{formatDate(p.scheduledAt)}</td>
                          <td>
                            <StatusBadge status={p.status} />
                          </td>
                          <td>
                            {p.status === 'SCHEDULED' && (
                              <button
                                className="btn btn-sm"
                                onClick={() => {
                                  setRescheduleId(p.id);
                                  setRescheduleMsg(null);
                                }}
                              >
                                Reschedule
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}

      {rescheduleId && (
        <Modal title="Reschedule Post" onClose={() => setRescheduleId(null)}>
          {rescheduleMutation.error != null && <ErrorMessage error={rescheduleMutation.error} />}
          <div className="field">
            <label>New time (must be in the future)</label>
            <input
              type="datetime-local"
              value={rescheduleAt}
              onChange={(e) => setRescheduleAt(e.target.value)}
            />
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setRescheduleId(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!rescheduleAt || rescheduleMutation.isPending}
              onClick={() => rescheduleMutation.mutate({ id: rescheduleId, at: rescheduleAt })}
            >
              {rescheduleMutation.isPending ? 'Saving…' : 'Reschedule'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
