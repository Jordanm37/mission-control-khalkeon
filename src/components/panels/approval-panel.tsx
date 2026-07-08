'use client'

import { useState, useCallback, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { apiFetch, ApiError } from '@/lib/api-client'
import { useSmartPoll } from '@/lib/use-smart-poll'

/**
 * ApprovalPanel
 * --------------
 * Lists khalkeon runs that are parked in the `needs_input` state — i.e. the
 * execution plane paused them at an approval gate and is waiting for a human
 * decision. Each row shows the run identity (run_id, project, agent) and the
 * reason the bridge recorded for the pause, plus Approve / Reject buttons.
 *
 * Data flow:
 *   GET /api/bridge/runs?state=needs_input  -> { runs: [...], count }
 *   POST /api/bridge/approve?run_id=<id>     -> { run_id, approval: {...} }
 *
 * The /api/bridge/* routes are Next.js API proxies (see
 * src/app/api/bridge/runs/route.ts and src/app/api/bridge/approve/route.ts)
 * that attach the server-side KHALKEON_WEB_TOKEN bearer and forward to
 * localhost:8000. The browser never sees the bridge directly.
 */

// ---- Bridge run shape (subset we render) -----------------------------------

/**
 * A run entry as returned by GET /api/bridge/runs.
 *
 * The bridge may include additional fields (started_at, cost, etc.) that we do
 * not render here; the index signature keeps this permissive without falling
 * back to `any`.
 */
export interface BridgeRun {
  run_id: string
  state: string
  project?: string
  agent?: string
  /** Human-readable reason the run entered needs_input, if the bridge sent one. */
  reason?: string
  /** Some bridges nest the reason under a needs_input object; tolerate both. */
  needs_input?: { reason?: string; action?: string } | string
  [key: string]: unknown
}

/** Response envelope for GET /api/bridge/runs. */
export interface BridgeRunsResponse {
  runs: BridgeRun[]
  count: number
}

/** Response envelope for POST /api/bridge/approve. */
export interface BridgeApproveResponse {
  run_id: string
  approval: {
    granted: boolean
    action: string
    approved_by: string
    timestamp: string
  }
}

// ---- Helpers ---------------------------------------------------------------

/** Extract a display reason from either the flat `reason` or nested `needs_input`. */
function readReason(run: BridgeRun): string | undefined {
  if (typeof run.reason === 'string' && run.reason.trim()) return run.reason
  const ni = run.needs_input
  if (typeof ni === 'string' && ni.trim()) return ni
  if (ni && typeof ni === 'object' && typeof ni.reason === 'string' && ni.reason.trim()) {
    return ni.reason
  }
  return undefined
}

/** Map an ApiError to a user-facing message key + params. */
function describeError(err: unknown): { key: string; params?: Record<string, string> } {
  if (err instanceof ApiError) {
    if (err.code === 'NETWORK_ERROR') return { key: 'bridgeUnreachable' }
    if (err.code === 'UNAUTHENTICATED') return { key: 'bridgeAuthFailed' }
    if (err.code === 'SERVER_ERROR') {
      if (err.status === 500) return { key: 'bridgeMisconfigured' }
      return { key: 'bridgeUnreachable' }
    }
    return { key: 'actionError', params: { message: err.message } }
  }
  if (err instanceof Error) return { key: 'actionError', params: { message: err.message } }
  return { key: 'actionError', params: { message: 'Unknown error' } }
}

// ---- Component -------------------------------------------------------------

export function ApprovalPanel() {
  const t = useTranslations('approvalGates')
  const [runs, setRuns] = useState<BridgeRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ key: string; params?: Record<string, string> } | null>(null)
  const [busyRunId, setBusyRunId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const fetchRuns = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<BridgeRunsResponse>('/api/bridge/runs?state=needs_input')
      setRuns(Array.isArray(data?.runs) ? data.runs : [])
    } catch (err) {
      setError(describeError(err))
      setRuns([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch + visibility-aware polling. The bridge registry updates as
  // runs enter/leave needs_input, so a 10s poll is enough.
  const refresh = useSmartPoll(fetchRuns, 10_000, { enabled: true })

  // Auto-dismiss the toast after a few seconds.
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 4_000)
    return () => clearTimeout(id)
  }, [toast])

  const handleDecision = useCallback(
    async (runId: string, granted: boolean) => {
      setBusyRunId(runId)
      setToast(null)
      try {
        const res = await apiFetch<BridgeApproveResponse>(
          `/api/bridge/approve?run_id=${encodeURIComponent(runId)}`,
          {
            method: 'POST',
            body: JSON.stringify({
              action: 'continue',
              granted,
              approved_by: 'dashboard',
            }),
          },
        )
        setToast({
          kind: 'success',
          text: granted
            ? t('approveSuccess', { run_id: res?.run_id ?? runId })
            : t('rejectSuccess', { run_id: res?.run_id ?? runId }),
        })
        // Refresh immediately so the resolved run leaves the list.
        refresh()
      } catch (err) {
        const { key, params } = describeError(err)
        setToast({ kind: 'error', text: t(key, params) })
      } finally {
        setBusyRunId(null)
      }
    },
    [refresh, t],
  )

  const pendingCount = runs.length

  return (
    <div className="m-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
          {pendingCount > 0 && (
            <span className="inline-flex items-center rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-medium text-amber-400 animate-pulse">
              {t('pendingBadge', { count: pendingCount })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('realtimeLabel')}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void refresh()
            }}
            disabled={loading}
          >
            {loading ? t('refreshing') : t('refresh')}
          </Button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={`mb-3 rounded-md border px-3 py-2 text-sm ${
            toast.kind === 'success'
              ? 'border-green-500/40 bg-green-500/10 text-green-400'
              : 'border-red-500/40 bg-red-500/10 text-red-400'
          }`}
        >
          {toast.text}
        </div>
      )}

      {/* Body */}
      {loading && runs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">
          {t('loading')}
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-4">
          <div className="text-sm font-medium text-red-400">
            {t('errorPrefix')}: {t(error.key, error.params)}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              void refresh()
            }}
          >
            {t('retry')}
          </Button>
        </div>
      ) : runs.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-sm text-muted-foreground">{t('noApprovals')}</div>
          <div className="text-xs text-muted-foreground mt-1">{t('noApprovalsHint')}</div>
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((run) => (
            <ApprovalRunCard
              key={run.run_id}
              run={run}
              busy={busyRunId === run.run_id}
              onApprove={() => void handleDecision(run.run_id, true)}
              onReject={() => void handleDecision(run.run_id, false)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ---- Run card --------------------------------------------------------------

function ApprovalRunCard({
  run,
  busy,
  onApprove,
  onReject,
}: {
  run: BridgeRun
  busy: boolean
  onApprove: () => void
  onReject: () => void
}) {
  const t = useTranslations('approvalGates')
  const reason = readReason(run)
  const project = typeof run.project === 'string' && run.project ? run.project : t('unknownProject')
  const agent = typeof run.agent === 'string' && run.agent ? run.agent : t('unknownAgent')

  return (
    <div className="rounded-lg border border-border bg-card p-4 border-l-4 border-l-amber-500">
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono text-xs bg-secondary rounded px-1.5 py-0.5 text-muted-foreground">
            {t('runId')}
          </span>
          <span className="font-mono text-sm text-foreground">{run.run_id}</span>
        </div>
        <span className="inline-flex items-center rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-400">
          {t('needsInput')}
        </span>
      </div>

      {/* Metadata */}
      <div className="text-xs text-muted-foreground mb-2 space-y-0.5">
        <div>
          {t('project')}: <span className="font-mono text-foreground">{project}</span>
        </div>
        <div>
          {t('agent')}: <span className="font-mono text-foreground">{agent}</span>
        </div>
      </div>

      {/* Reason block */}
      {reason && (
        <pre className="bg-secondary rounded p-2 text-xs font-mono overflow-auto max-h-32 text-foreground mb-2 border border-border whitespace-pre-wrap">
          {reason}
        </pre>
      )}
      {!reason && (
        <div className="text-xs text-muted-foreground mb-2 italic">{t('unknownReason')}</div>
      )}

      {/* Action row */}
      <div className="flex items-center gap-2 mt-3">
        <Button
          size="sm"
          className="bg-green-600 hover:bg-green-700 text-white"
          onClick={onApprove}
          disabled={busy}
        >
          {busy ? t('approving') : t('approve')}
        </Button>
        <Button
          size="sm"
          className="bg-red-600 hover:bg-red-700 text-white"
          onClick={onReject}
          disabled={busy}
        >
          {busy ? t('rejecting') : t('reject')}
        </Button>
      </div>
    </div>
  )
}
