'use client'

import { useState, useCallback, useMemo, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { apiFetch, ApiError } from '@/lib/api-client'

/**
 * OpenspecCardsPanel
 *
 * Reads OpenSpec change proposals from the khalkeon bridge (via the
 * /api/bridge/openspec/changes proxy) and renders them as a card grid.
 * Each card shows the change id, proposal summary, task progress and a
 * has_design badge. The Dispatch button turns a change into an MC task
 * (POST /api/tasks) carrying the change metadata so a downstream agent
 * can pick it up.
 *
 * Bridge contract (GET /openspec/changes):
 *   { changes: [{
 *       id, project, path, proposal_summary,
 *       tasks_total, tasks_completed, has_design, dispatched
 *     }],
 *     dry_run: bool }
 */

interface OpenspecChange {
  id: string
  project: string
  path: string
  proposal_summary: string
  tasks_total: number
  tasks_completed: number
  has_design: boolean
  dispatched?: boolean
}

interface OpenspecResponse {
  changes: OpenspecChange[]
  dry_run?: boolean
}

function firstParagraph(text: string): string {
  if (!text) return ''
  const trimmed = text.trim()
  const paraBreak = trimmed.indexOf('\n\n')
  if (paraBreak === -1) return trimmed
  return trimmed.slice(0, paraBreak).trim()
}

export function OpenspecCardsPanel() {
  const t = useTranslations('openspecCards')
  const [changes, setChanges] = useState<OpenspecChange[]>([])
  const [dryRun, setDryRun] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [projectFilter, setProjectFilter] = useState<string>('all')
  const [dispatchingId, setDispatchingId] = useState<string | null>(null)
  const [dispatchedIds, setDispatchedIds] = useState<Set<string>>(new Set())
  const [dispatchError, setDispatchError] = useState('')

  const fetchChanges = useCallback(async () => {
    try {
      setLoading(true)
      const data = await apiFetch<OpenspecResponse>('/api/bridge/openspec/changes')
      const list = Array.isArray(data?.changes) ? data.changes : []
      setChanges(list)
      setDryRun(!!data?.dry_run)
      setError('')
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError('Failed to load OpenSpec changes')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void fetchChanges() }, [fetchChanges])
  useSmartPoll(fetchChanges, 30_000, { pauseWhenDisconnected: true })

  const projects = useMemo(() => {
    const seen = new Map<string, number>()
    for (const c of changes) {
      seen.set(c.project, (seen.get(c.project) ?? 0) + 1)
    }
    return Array.from(seen.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [changes])

  const filtered = useMemo(() => {
    if (projectFilter === 'all') return changes
    return changes.filter((c) => c.project === projectFilter)
  }, [changes, projectFilter])

  const handleDispatch = useCallback(
    async (change: OpenspecChange) => {
      setDispatchingId(change.id)
      setDispatchError('')
      try {
        await apiFetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: change.id,
            description: firstParagraph(change.proposal_summary),
            metadata: {
              openspec_change: change.path,
              project: change.project,
              agent: 'claude',
            },
          }),
        })
        setDispatchedIds((prev) => {
          const next = new Set(prev)
          next.add(change.id)
          return next
        })
      } catch (err) {
        if (err instanceof ApiError) {
          setDispatchError(err.message)
        } else {
          setDispatchError('Failed to dispatch change as a task')
        }
      } finally {
        setDispatchingId(null)
      }
    },
    []
  )

  return (
    <div className="p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('subtitle', { count: changes.length })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dryRun && (
            <span className="text-2xs font-mono px-2 py-1 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
              {t('dryRun')}
            </span>
          )}
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="h-8 px-2 text-xs rounded-md border border-border bg-background text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('projectFilter')}
          >
            <option value="all">{t('allProjects')}</option>
            {projects.map(([name, count]) => (
              <option key={name} value={name}>
                {name} ({count})
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {dispatchError && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
          {dispatchError}
        </div>
      )}

      {/* Card grid */}
      {loading && filtered.length === 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-40 rounded-lg shimmer" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-xs text-muted-foreground">
            {error ? t('unreachable') : t('noChanges')}
          </p>
          <p className="text-2xs text-muted-foreground/60 mt-1">{t('noChangesDesc')}</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((change) => (
            <OpenspecCard
              key={change.id}
              change={change}
              dispatching={dispatchingId === change.id}
              dispatched={dispatchedIds.has(change.id) || !!change.dispatched}
              onDispatch={handleDispatch}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function OpenspecCard({
  change,
  dispatching,
  dispatched,
  onDispatch,
}: {
  change: OpenspecChange
  dispatching: boolean
  dispatched: boolean
  onDispatch: (change: OpenspecChange) => void
}) {
  const t = useTranslations('openspecCards')
  const summary = firstParagraph(change.proposal_summary)
  const total = change.tasks_total ?? 0
  const completed = change.tasks_completed ?? 0
  const progress = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0
  const fullyDone = total > 0 && completed >= total

  return (
    <div className="rounded-lg border border-border p-4 space-y-3 flex flex-col">
      {/* Title row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">{change.id}</span>
          </div>
          <p className="text-2xs text-muted-foreground font-mono mt-0.5 truncate">{change.path}</p>
        </div>
        <span className="text-2xs font-mono px-1.5 py-0.5 rounded bg-secondary text-muted-foreground shrink-0">
          {change.project}
        </span>
      </div>

      {/* Summary */}
      <p className="text-xs text-muted-foreground line-clamp-3 min-h-[2.5rem]">
        {summary || t('noSummary')}
      </p>

      {/* Task progress */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-2xs">
          <span className="text-muted-foreground">{t('tasks')}</span>
          <span
            className={`font-mono ${fullyDone ? 'text-green-400' : 'text-muted-foreground'}`}
          >
            {completed} / {total}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${fullyDone ? 'bg-green-500' : 'bg-primary'}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Badges */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`text-2xs font-medium px-1.5 py-0.5 rounded border ${
            change.has_design
              ? 'bg-green-500/10 text-green-400 border-green-500/30'
              : 'bg-secondary text-muted-foreground border-border'
          }`}
        >
          {change.has_design ? t('hasDesign') : t('noDesign')}
        </span>
        {dispatched && (
          <span className="text-2xs font-medium px-1.5 py-0.5 rounded border bg-blue-500/10 text-blue-400 border-blue-500/30">
            {t('dispatched')}
          </span>
        )}
      </div>

      {/* Dispatch */}
      <div className="pt-1 mt-auto">
        <Button
          size="sm"
          variant={dispatched ? 'outline' : 'default'}
          className="w-full"
          disabled={dispatching || dispatched}
          onClick={() => onDispatch(change)}
        >
          {dispatching
            ? t('dispatching')
            : dispatched
              ? t('dispatched')
              : t('dispatch')}
        </Button>
      </div>
    </div>
  )
}
