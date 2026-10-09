import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, ApiError } from '../api.ts';
import type { Incident, IncidentImpact, IncidentStatus, MonitorGroup } from '../types.ts';
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Panel,
  Skeleton,
  inputClass,
  selectClass,
  timeAgo,
} from '../components/ui.tsx';

/**
 * Incident management.
 *
 * An incident is the human-facing half of monitoring: a check going down is a
 * fact, an incident is the story told to customers and to colleagues. This
 * screen exists because the API for it (`/api/incidents`) was complete long
 * before any UI did — incidents could be created by hand or by nothing at all.
 *
 * Status follows the industry convention of monotonically progressing phases
 * (investigating → identified → monitoring → resolved), and the server derives
 * `resolved_at` from the status, so the UI only has to send the new status.
 */

const STATUS_FLOW: IncidentStatus[] = ['investigating', 'identified', 'monitoring', 'resolved'];

const STATUS_LABEL: Record<IncidentStatus, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};

const IMPACT_LABEL: Record<IncidentImpact, string> = {
  none: 'None',
  minor: 'Minor',
  major: 'Major',
  critical: 'Critical',
};

/** Impact is a severity, so it gets the status palette rather than a new one. */
function impactTone(impact: IncidentImpact): string {
  if (impact === 'critical') return 'var(--color-down)';
  if (impact === 'major') return 'var(--color-degraded)';
  if (impact === 'minor') return 'var(--color-accent)';
  return 'var(--color-text-tertiary)';
}

function isResolved(incident: Incident): boolean {
  return incident.status === 'resolved' || incident.resolved_at !== null;
}

export function IncidentsPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [groups, setGroups] = useState<MonitorGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showResolved, setShowResolved] = useState(true);
  const [groupFilter, setGroupFilter] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  // Composer state.
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState('');
  const [impact, setImpact] = useState<IncidentImpact>('minor');
  const [groupId, setGroupId] = useState('');
  const [firstUpdate, setFirstUpdate] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // The incident whose update composer is open.
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<IncidentStatus>('identified');
  const [updateMessage, setUpdateMessage] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [incidentResult, groupResult] = await Promise.all([
        api.incidents({ include_resolved: true }),
        api.groups(),
      ]);
      setIncidents(incidentResult.incidents ?? []);
      setGroups(groupResult.groups ?? []);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load incidents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    return incidents
      .filter((incident) => (showResolved ? true : !isResolved(incident)))
      .filter((incident) => (groupFilter ? incident.group_id === groupFilter : true));
  }, [incidents, showResolved, groupFilter]);

  const openCount = useMemo(
    () => incidents.filter((incident) => !isResolved(incident)).length,
    [incidents],
  );

  function resetComposer() {
    setComposing(false);
    setTitle('');
    setImpact('minor');
    setGroupId('');
    setFirstUpdate('');
    setFieldErrors({});
  }

  async function submit() {
    setBusy(true);
    setFieldErrors({});
    try {
      await api.createIncident({
        title,
        impact,
        group_id: groupId || null,
        status: 'investigating',
        // The server writes the opening timeline entry atomically with the
        // incident, so an incident is never briefly without an update.
        message: firstUpdate || 'We are investigating this issue.',
      });
      resetComposer();
      setNotice('Incident created');
      await load();
    } catch (cause) {
      if (cause instanceof ApiError) {
        setFieldErrors(
          Object.fromEntries(cause.issues.map((issue) => [issue.field, issue.message])),
        );
        setError(cause.message);
      } else {
        setError('Could not create the incident');
      }
    } finally {
      setBusy(false);
    }
  }

  async function advance(incident: Incident, status: IncidentStatus, message: string) {
    setBusy(true);
    try {
      await api.updateIncident(incident.id, { status, ...(message ? { message } : {}) });
      setUpdatingId(null);
      setUpdateMessage('');
      setNotice(`Incident marked ${STATUS_LABEL[status].toLowerCase()}`);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not update the incident');
    } finally {
      setBusy(false);
    }
  }

  async function remove(incident: Incident) {
    if (!confirm(`Delete "${incident.title}"? Its timeline updates go with it. This cannot be undone.`)) {
      return;
    }
    setBusy(true);
    try {
      await api.deleteIncident(incident.id);
      setNotice('Incident deleted');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not delete the incident');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Incidents</h1>
          <p className="text-xs text-[var(--color-text-tertiary)]">
            {openCount === 0 ? 'No open incidents' : `${openCount} open`}
            {openCount > 0 ? ' · ' : ''}
            {incidents.length} total
          </p>
        </div>
        <Button variant="primary" onClick={() => (composing ? resetComposer() : setComposing(true))}>
          {composing ? 'Cancel' : 'New incident'}
        </Button>
      </header>

      {notice ? (
        <p className="text-xs text-[var(--color-up)]" role="status">
          {notice}
        </p>
      ) : null}
      {error ? <ErrorNote message={error} onRetry={() => void load()} /> : null}

      {composing ? (
        <Panel title="New incident">
          <div className="space-y-4">
            <Field label="Title" error={fieldErrors.title}>
              <input
                className={inputClass}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Elevated error rates on the checkout API"
                maxLength={200}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Impact">
                <select
                  className={selectClass}
                  value={impact}
                  onChange={(e) => setImpact(e.target.value as IncidentImpact)}
                >
                  {(['none', 'minor', 'major', 'critical'] as IncidentImpact[]).map((value) => (
                    <option key={value} value={value}>
                      {IMPACT_LABEL[value]}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Group" hint="Optional — links the incident to a status page section.">
                <select className={selectClass} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  <option value="">No group</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Opening update" hint="Posted as the first timeline entry.">
              <textarea
                className={`${inputClass} min-h-20`}
                value={firstUpdate}
                onChange={(e) => setFirstUpdate(e.target.value)}
                placeholder="We are aware of the issue and are looking into it."
              />
            </Field>

            <div className="flex gap-2">
              <Button variant="primary" busy={busy} onClick={() => void submit()}>
                Create incident
              </Button>
              <Button onClick={resetComposer}>Cancel</Button>
            </div>
          </div>
        </Panel>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Show resolved
        </label>

        {groups.length > 0 ? (
          <select
            className={`${selectClass} w-auto`}
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            aria-label="Filter by group"
          >
            <option value="">All groups</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Panel>
          <EmptyState
            title={incidents.length === 0 ? 'No incidents recorded' : 'Nothing matches this filter'}
            description={
              incidents.length === 0
                ? 'When a service degrades you can open one here to keep a public timeline.'
                : 'Try widening the filters above.'
            }
            action={
              incidents.length === 0 ? (
                <Button variant="primary" onClick={() => setComposing(true)}>
                  New incident
                </Button>
              ) : undefined
            }
          />
        </Panel>
      ) : (
        <div className="space-y-3">
          {visible.map((incident) => (
            <IncidentCard
              key={incident.id}
              incident={incident}
              groups={groups}
              busy={busy}
              updating={updatingId === incident.id}
              updateStatus={updateStatus}
              updateMessage={updateMessage}
              onUpdateStatus={setUpdateStatus}
              onUpdateMessage={setUpdateMessage}
              onOpenUpdate={() => {
                setUpdatingId(updatingId === incident.id ? null : incident.id);
                setUpdateMessage('');
                // Default to the next phase rather than leaving it on
                // `identified`, which would silently skip a stage.
                const index = STATUS_FLOW.indexOf(incident.status);
                setUpdateStatus(STATUS_FLOW[Math.min(index + 1, STATUS_FLOW.length - 1)]!);
              }}
              onSubmitUpdate={() => void advance(incident, updateStatus, updateMessage)}
              onDelete={() => void remove(incident)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function IncidentCard({
  incident,
  groups,
  busy,
  updating,
  updateStatus,
  updateMessage,
  onUpdateStatus,
  onUpdateMessage,
  onOpenUpdate,
  onSubmitUpdate,
  onDelete,
}: {
  incident: Incident;
  groups: MonitorGroup[];
  busy: boolean;
  updating: boolean;
  updateStatus: IncidentStatus;
  updateMessage: string;
  onUpdateStatus: (status: IncidentStatus) => void;
  onUpdateMessage: (message: string) => void;
  onOpenUpdate: () => void;
  onSubmitUpdate: () => void;
  onDelete: () => void;
}) {
  const resolved = isResolved(incident);
  const group = groups.find((g) => g.id === incident.group_id);

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <span className="truncate-1">{incident.title}</span>
          {incident.auto_created ? <Badge>auto</Badge> : null}
        </span>
      }
      subtitle={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Opened {timeAgo(incident.created_at)}</span>
          {resolved ? <span>Resolved {timeAgo(incident.resolved_at)}</span> : null}
          {group ? <span>{group.name}</span> : null}
        </span>
      }
      actions={
        <>
          <Badge color={impactTone(incident.impact)}>{IMPACT_LABEL[incident.impact]}</Badge>
          <Badge
            color={
              resolved
                ? 'var(--color-up)'
                : incident.status === 'investigating'
                  ? 'var(--color-down)'
                  : 'var(--color-degraded)'
            }
          >
            {STATUS_LABEL[incident.status]}
          </Badge>
        </>
      }
    >
      <div className="space-y-4">
        {incident.updates && incident.updates.length > 0 ? (
          <ol className="space-y-3 border-l border-[var(--color-border-subtle)] pl-4">
            {incident.updates.map((update) => (
              <li key={update.id} className="relative">
                <span
                  className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-[var(--color-border-strong)]"
                  aria-hidden="true"
                />
                <p className="flex flex-wrap items-baseline gap-2">
                  <span className="text-xs font-medium text-[var(--color-text-primary)]">
                    {STATUS_LABEL[update.status] ?? update.status}
                  </span>
                  <span className="tabular text-[11px] text-[var(--color-text-tertiary)]">
                    {timeAgo(update.created_at)}
                  </span>
                </p>
                <p className="mt-0.5 text-sm text-[var(--color-text-secondary)]">{update.message}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-[var(--color-text-tertiary)]">No timeline updates yet.</p>
        )}

        {updating ? (
          <div className="space-y-3 border-t border-[var(--color-border-subtle)] pt-4">
            <Field label="Set status">
              <select
                className={selectClass}
                value={updateStatus}
                onChange={(e) => onUpdateStatus(e.target.value as IncidentStatus)}
              >
                {STATUS_FLOW.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABEL[status]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Update" hint="Posted to the public timeline.">
              <textarea
                className={`${inputClass} min-h-20`}
                value={updateMessage}
                onChange={(e) => onUpdateMessage(e.target.value)}
                placeholder="Root cause identified — rolling back the bad deploy."
              />
            </Field>
            <div className="flex gap-2">
              <Button variant="primary" busy={busy} onClick={onSubmitUpdate}>
                Post update
              </Button>
              <Button onClick={onOpenUpdate}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 border-t border-[var(--color-border-subtle)] pt-4">
            <Button size="sm" onClick={onOpenUpdate}>
              {resolved ? 'Add update' : 'Post update'}
            </Button>
            <Button size="sm" variant="danger" onClick={onDelete}>
              Delete
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}