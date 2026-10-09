import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../api.ts';
import type { MonitorGroup } from '../types.ts';
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Panel,
  Skeleton,
  inputClass,
} from '../components/ui.tsx';

/**
 * Groups admin.
 *
 * A group does two jobs at once: it organises monitors on the dashboard, and
 * marking it public is what publishes it on `/status`. Keeping both in one
 * place is deliberate — an operator should not have to learn two screens to
 * answer "is my status page live?".
 */
export function GroupsPage() {
  const [groups, setGroups] = useState<MonitorGroup[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /** Which group is open in the inline editor, and its draft values. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edits, setEdits] = useState({ name: '', slug: '', description: '', theme: '' });

  const load = useCallback(async () => {
    setError(null);
    try {
      const [groupResult, monitorResult] = await Promise.all([
        api.groups(),
        api.monitors({ limit: 200 }),
      ]);
      setGroups(groupResult.groups ?? []);

      const byGroup: Record<string, number> = {};
      for (const monitor of monitorResult.monitors) {
        if (monitor.group_id) byGroup[monitor.group_id] = (byGroup[monitor.group_id] ?? 0) + 1;
      }
      setCounts(byGroup);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load groups');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      await api.createGroup({
        name,
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        is_public: isPublic,
      });
      setName('');
      setSlug('');
      setDescription('');
      await load();
    } catch (cause) {
      if (cause instanceof ApiError) {
        setFieldErrors(Object.fromEntries(cause.issues.map((i) => [i.field, i.message])));
        setError(cause.message);
      } else {
        setError('Could not create the group');
      }
    } finally {
      setBusy(false);
    }
  }

  async function togglePublic(group: MonitorGroup) {
    setBusy(true);
    try {
      await api.updateGroup(group.id, { is_public: !group.is_public });
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(group: MonitorGroup) {
    const count = counts[group.id] ?? 0;
    const message = count
      ? `Delete "${group.name}"? ${count} monitor(s) will become ungrouped — their history is kept.`
      : `Delete "${group.name}"?`;
    if (!confirm(message)) return;

    setBusy(true);
    try {
      await api.deleteGroup(group.id);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Editing is inline rather than a separate screen: the group list is the only
   * thing this page shows, and a rename is a two-field change. Opening a modal
   * to retype a name is friction without focus.
   */
  async function saveEdits(group: MonitorGroup) {
    setBusy(true);
    setFieldErrors({});
    try {
      await api.updateGroup(group.id, {
        name: edits.name,
        slug: edits.slug || null,
        description: edits.description || null,
        theme: edits.theme || null,
      });
      setEditingId(null);
      await load();
    } catch (cause) {
      if (cause instanceof ApiError) {
        setFieldErrors(Object.fromEntries(cause.issues.map((i) => [i.field, i.message])));
        setError(cause.message);
      } else {
        setError('Could not save the group');
      }
    } finally {
      setBusy(false);
    }
  }

  function startEdit(group: MonitorGroup) {
    setEditingId(group.id);
    setEdits({
      name: group.name,
      slug: group.slug ?? '',
      description: group.description ?? '',
      theme: group.theme ?? '',
    });
    setFieldErrors({});
  }

  /**
   * Ordering is a plain integer, so move-by-one is the whole feature. Reordering
   * writes each affected row rather than swapping in the UI, because the list
   * is sorted by the server and a local swap would snap back on the next load.
   */
  async function move(group: MonitorGroup, direction: -1 | 1) {
    const index = groups.findIndex((g) => g.id === group.id);
    const neighbour = groups[index + direction];
    if (!neighbour) return;

    setBusy(true);
    try {
      await Promise.all([
        api.updateGroup(group.id, { display_order: neighbour.display_order }),
        api.updateGroup(neighbour.id, { display_order: group.display_order }),
      ]);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not reorder');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Skeleton className="h-64" />;

  const publicGroups = groups.filter((group) => group.is_public);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Groups</h1>
        <p className="mt-1 text-sm text-[var(--color-text-tertiary)]">
          Group monitors together and choose which groups appear on the public status page.
        </p>
      </div>

      {error ? <ErrorNote message={error} onRetry={load} /> : null}

      {groups.length === 0 ? (
        <Panel>
          <EmptyState
            title="No groups yet"
            description="Create one below. A group marked public shows up at /status."
          />
        </Panel>
      ) : (
        <div className="grid gap-2.5 md:grid-cols-2">
          {groups.map((group) => (
            <Panel key={group.id} bodyClassName="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate-1 text-sm font-medium">{group.name}</span>
                    {group.is_public ? (
                      <Badge color="var(--color-up)">public</Badge>
                    ) : (
                      <Badge>private</Badge>
                    )}
                  </div>
                  {group.description ? (
                    <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">{group.description}</p>
                  ) : null}
                  <p className="mt-1.5 text-[11px] text-[var(--color-text-tertiary)]">
                    {counts[group.id] ?? 0} monitor{(counts[group.id] ?? 0) === 1 ? '' : 's'}
                    {group.slug ? ` · /status/${group.slug}` : ''}
                  </p>
                </div>

                <div className="flex shrink-0 flex-col gap-1.5">
                  {group.slug ? (
                    <Link
                      to={`/status/${group.slug}`}
                      className="text-center text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                    >
                      View page
                    </Link>
                  ) : null}
                  <Button size="sm" variant="ghost" busy={busy} onClick={() => startEdit(group)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" busy={busy} onClick={() => togglePublic(group)}>
                    {group.is_public ? 'Unpublish' : 'Publish'}
                  </Button>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={busy}
                      aria-label={`Move ${group.name} up`}
                      disabled={groups[0]?.id === group.id}
                      onClick={() => void move(group, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={busy}
                      aria-label={`Move ${group.name} down`}
                      disabled={groups[groups.length - 1]?.id === group.id}
                      onClick={() => void move(group, 1)}
                    >
                      ↓
                    </Button>
                  </div>
                  <Button size="sm" variant="danger" busy={busy} onClick={() => remove(group)}>
                    Delete
                  </Button>
                </div>
              </div>

              {editingId === group.id ? (
                <div className="mt-3 space-y-3 border-t border-[var(--color-border-subtle)] pt-3">
                  <Field label="Name" error={fieldErrors.name}>
                    <input
                      className={inputClass}
                      value={edits.name}
                      onChange={(e) => setEdits({ ...edits, name: e.target.value })}
                      maxLength={120}
                    />
                  </Field>
                  <Field
                    label="Slug"
                    hint="Lowercase, numbers and dashes. Enables /status/<slug>."
                    error={fieldErrors.slug}
                  >
                    <input
                      className={inputClass}
                      value={edits.slug}
                      onChange={(e) => setEdits({ ...edits, slug: e.target.value })}
                      placeholder="core-services"
                    />
                  </Field>
                  <Field label="Description" error={fieldErrors.description}>
                    <input
                      className={inputClass}
                      value={edits.description}
                      onChange={(e) => setEdits({ ...edits, description: e.target.value })}
                      maxLength={500}
                    />
                  </Field>
                  <Field label="Theme" hint="Free-form label carried through to the public page.">
                    <input
                      className={inputClass}
                      value={edits.theme}
                      onChange={(e) => setEdits({ ...edits, theme: e.target.value })}
                      placeholder="dark"
                      maxLength={40}
                    />
                  </Field>
                  <div className="flex gap-2">
                    <Button variant="primary" size="sm" busy={busy} onClick={() => void saveEdits(group)}>
                      Save
                    </Button>
                    <Button size="sm" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </Panel>
          ))}
        </div>
      )}

      <Panel title="New group">
        <form className="space-y-3.5" onSubmit={create}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" error={fieldErrors.name}>
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Core services"
                required
              />
            </Field>
            <Field label="Slug" hint="Optional — enables /status/<slug>" error={fieldErrors.slug}>
              <input
                className={inputClass}
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="core-services"
              />
            </Field>
          </div>

          <Field label="Description" error={fieldErrors.description}>
            <input
              className={inputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this group covers"
            />
          </Field>

          <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              className="size-3.5 accent-[var(--color-accent)]"
            />
            Publish on the public status page
          </label>

          <Button type="submit" variant="primary" busy={busy}>
            Create group
          </Button>
        </form>
      </Panel>

      {publicGroups.length > 0 ? (
        <p className="text-xs text-[var(--color-text-tertiary)]">
          Live status page:{' '}
          <Link to="/status" className="text-[var(--color-accent-text)] hover:underline">
            /status
          </Link>
        </p>
      ) : null}
    </div>
  );
}