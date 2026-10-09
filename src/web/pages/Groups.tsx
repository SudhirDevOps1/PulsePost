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

  if (loading) return <Skeleton className="h-64" />;

  const publicGroups = groups.filter((group) => group.is_public);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Groups</h1>
        <p className="mt-1 text-sm text-[--color-text-tertiary]">
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
                    <p className="mt-1 text-xs text-[--color-text-tertiary]">{group.description}</p>
                  ) : null}
                  <p className="mt-1.5 text-[11px] text-[--color-text-tertiary]">
                    {counts[group.id] ?? 0} monitor{(counts[group.id] ?? 0) === 1 ? '' : 's'}
                    {group.slug ? ` · /status/${group.slug}` : ''}
                  </p>
                </div>

                <div className="flex shrink-0 flex-col gap-1.5">
                  <Button size="sm" variant="ghost" busy={busy} onClick={() => togglePublic(group)}>
                    {group.is_public ? 'Unpublish' : 'Publish'}
                  </Button>
                  <Button size="sm" variant="danger" busy={busy} onClick={() => remove(group)}>
                    Delete
                  </Button>
                </div>
              </div>
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

          <label className="flex items-center gap-2 text-xs text-[--color-text-secondary]">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              className="size-3.5 accent-[--color-accent]"
            />
            Publish on the public status page
          </label>

          <Button type="submit" variant="primary" busy={busy}>
            Create group
          </Button>
        </form>
      </Panel>

      {publicGroups.length > 0 ? (
        <p className="text-xs text-[--color-text-tertiary]">
          Live status page:{' '}
          <Link to="/status" className="text-[--color-accent] hover:underline">
            /status
          </Link>
        </p>
      ) : null}
    </div>
  );
}