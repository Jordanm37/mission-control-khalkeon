'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { apiFetch, ApiError } from '@/lib/api-client'
import { createClientLogger } from '@/lib/client-logger'

const log = createClientLogger('EvidencePanel')

// ── Types ──────────────────────────────────────────

/**
 * Evidence files keyed by their filename. The khalkeon bridge collects the
 * artifacts a finished run produced and returns them as a flat
 * { filename: contents } map. The four well-known files are:
 *   tests.log     — test runner output
 *   diff.summary  — a textual summary of the changeset
 *   pr_url.txt    — a single URL pointing at the pull request
 *   lint.log      — linter output
 * Other files the bridge may add are rendered generically.
 */
type EvidenceMap = Record<string, string>

interface EvidenceResponse {
  run_id: string
  evidence: EvidenceMap
}

// The canonical sections, in display order. Each may be absent.
const WELL_KNOWN: ReadonlyArray<{
  key: string
  label: string
  kind: 'log' | 'diff' | 'link'
  description: string
}> = [
  {
    key: 'tests.log',
    label: 'Test output',
    kind: 'log',
    description: 'Test runner output for this run.',
  },
  {
    key: 'diff.summary',
    label: 'Diff summary',
    kind: 'diff',
    description: 'Textual summary of the changeset produced by the run.',
  },
  {
    key: 'pr_url.txt',
    label: 'Pull request',
    kind: 'link',
    description: 'Link to the pull request opened by the run.',
  },
  {
    key: 'lint.log',
    label: 'Lint output',
    kind: 'log',
    description: 'Linter output for this run.',
  },
]

// ── Helpers ──────────────────────────────────────────

/** True for filenames the bridge treats as a single URL rather than log text. */
function isUrlFile(key: string): boolean {
  return key === 'pr_url.txt' || key.endsWith('.url.txt') || key.endsWith('_url.txt')
}

/** Normalize PR URL contents: trim whitespace, take the first non-empty line. */
function extractUrl(contents: string): string | null {
  const line = contents
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line && /^https?:\/\//i.test(line) ? line : null
}

// ── Sub-components ──────────────────────────────────

function EvidenceLogBlock({
  label,
  description,
  contents,
  monospace,
}: {
  label: string
  description: string
  contents: string
  monospace: boolean
}) {
  const [expanded, setExpanded] = useState(true)
  const lineCount = useMemo(() => contents.split(/\r?\n/).length, [contents])
  const charCount = contents.length

  return (
    <section className="rounded-lg border border-border bg-card overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground truncate">{label}</h3>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{description}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-muted-foreground tabular-nums">
            {lineCount} {lineCount === 1 ? 'line' : 'lines'} · {charCount} {charCount === 1 ? 'char' : 'chars'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          >
            {expanded ? 'Collapse' : 'Expand'}
          </Button>
        </div>
      </header>
      {expanded && (
        <pre
          className={`overflow-auto p-4 text-xs text-foreground bg-card max-h-96 ${
            monospace ? 'font-mono whitespace-pre' : 'font-mono whitespace-pre-wrap break-words'
          }`}
        >
          {contents || '(empty)'}
        </pre>
      )}
    </section>
  )
}

function EvidenceLinkBlock({
  label,
  description,
  contents,
}: {
  label: string
  description: string
  contents: string
}) {
  const url = extractUrl(contents)

  return (
    <section className="rounded-lg border border-border bg-card overflow-hidden">
      <header className="px-4 py-3 border-b border-border bg-muted/30">
        <h3 className="text-sm font-semibold text-foreground truncate">{label}</h3>
        <p className="text-xs text-muted-foreground mt-0.5 truncate">{description}</p>
      </header>
      <div className="p-4">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline break-all"
          >
            {url}
            <span className="text-muted-foreground" aria-hidden>↗</span>
          </a>
        ) : (
          <p className="text-sm text-muted-foreground">
            No valid URL found in this file.
          </p>
        )}
      </div>
    </section>
  )
}

// ── Main Component ──────────────────────────────────

export interface EvidencePanelProps {
  /**
   * The run id whose evidence should be displayed. When omitted, the panel
   * reads `run_id` from the URL query string (e.g. `?run_id=abc123`), which is
   * how the dashboard routes to it via the ContentRouter.
   */
  runId?: string
}

export function EvidencePanel({ runId: runIdProp }: EvidencePanelProps = {}) {
  const searchParams = useSearchParams()

  const runId = (runIdProp ?? searchParams?.get('run_id') ?? '').trim()

  const [data, setData] = useState<EvidenceResponse | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState<boolean>(false)
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true)
  const [lastRefresh, setLastRefresh] = useState<number>(0)

  const runIdRef = useRef(runId)
  useEffect(() => {
    runIdRef.current = runId
  }, [runId])

  const fetchEvidence = useCallback(async () => {
    const currentRunId = runIdRef.current
    if (!currentRunId) {
      setData(null)
      setError(null)
      setNotFound(false)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    setNotFound(false)

    try {
      const params = new URLSearchParams({ run_id: currentRunId })
      const result = await apiFetch<EvidenceResponse>(
        `/api/bridge/evidence?${params.toString()}`,
      )
      setData(result)
      setLastRefresh(Date.now())
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NOT_FOUND') {
        setNotFound(true)
        setData(null)
      } else {
        const message =
          err instanceof Error ? err.message : 'Failed to load evidence'
        setError(message)
        setData(null)
        log.error({ err, runId: currentRunId }, 'EvidencePanel: fetch failed')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  // Refetch whenever the run id changes.
  useEffect(() => {
    fetchEvidence()
  }, [runId, fetchEvidence])

  // Poll for fresh evidence while auto-refresh is on. Evidence is a terminal
  // artifact of a finished run, so a slow cadence is appropriate.
  useSmartPoll(fetchEvidence, 30_000, {
    enabled: autoRefresh && !!runId,
    pauseWhenSseConnected: true,
  })

  // ── Derived render data ──────────────────────
  const evidence = data?.evidence ?? {}
  const knownKeys = new Set(WELL_KNOWN.map((w) => w.key))
  const extraFiles = Object.keys(evidence)
    .filter((k) => !knownKeys.has(k))
    .sort()
  const hasAnyEvidence = Object.keys(evidence).length > 0

  // ── Empty / missing run id state ─────────────
  if (!runId) {
    return (
      <div className="h-full flex flex-col">
        <PanelHeader
          title="Run evidence"
          runId={null}
          autoRefresh={autoRefresh}
          setAutoRefresh={setAutoRefresh}
          onRefresh={fetchEvidence}
          lastRefresh={lastRefresh}
        />
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <p className="text-sm text-muted-foreground">
              No run selected. Pass a run id with{' '}
              <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                ?run_id=&lt;run_id&gt;
              </code>{' '}
              in the URL.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title="Run evidence"
        runId={runId}
        autoRefresh={autoRefresh}
        setAutoRefresh={setAutoRefresh}
        onRefresh={fetchEvidence}
        lastRefresh={lastRefresh}
      />

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {loading && !data && <LoadingState />}

        {!loading && error && <ErrorState message={error} onRetry={fetchEvidence} />}

        {!loading && !error && notFound && (
          <EmptyState runId={runId} onRetry={fetchEvidence} />
        )}

        {!loading && !error && !notFound && data && !hasAnyEvidence && (
          <NoFilesState runId={runId} />
        )}

        {!loading && !error && !notFound && data && hasAnyEvidence && (
          <>
            {WELL_KNOWN.map((spec) => {
              const contents = evidence[spec.key]
              if (contents === undefined) {
                // Render a placeholder so the user can see which expected
                // artifacts are still missing for this run.
                return (
                  <MissingFileBlock
                    key={spec.key}
                    label={spec.label}
                    filename={spec.key}
                    description={spec.description}
                  />
                )
              }
              if (spec.kind === 'link') {
                return (
                  <EvidenceLinkBlock
                    key={spec.key}
                    label={spec.label}
                    description={spec.description}
                    contents={contents}
                  />
                )
              }
              return (
                <EvidenceLogBlock
                  key={spec.key}
                  label={spec.label}
                  description={spec.description}
                  contents={contents}
                  monospace={spec.kind === 'log'}
                />
              )
            })}

            {extraFiles.length > 0 && (
              <div className="space-y-4 pt-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Additional files
                </h3>
                {extraFiles.map((filename) => {
                  const contents = evidence[filename] ?? ''
                  if (isUrlFile(filename)) {
                    return (
                      <EvidenceLinkBlock
                        key={filename}
                        label={filename}
                        description="Additional evidence file collected by the bridge."
                        contents={contents}
                      />
                    )
                  }
                  return (
                    <EvidenceLogBlock
                      key={filename}
                      label={filename}
                      description="Additional evidence file collected by the bridge."
                      contents={contents}
                      monospace
                    />
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Header ──────────────────────────────────────────

function PanelHeader({
  title,
  runId,
  autoRefresh,
  setAutoRefresh,
  onRefresh,
  lastRefresh,
}: {
  title: string
  runId: string | null
  autoRefresh: boolean
  setAutoRefresh: (v: boolean) => void
  onRefresh: () => void
  lastRefresh: number
}) {
  return (
    <div className="flex justify-between items-center p-4 border-b border-border shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <h2 className="text-xl font-bold text-foreground">{title}</h2>
        {runId && (
          <code className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded truncate max-w-[20rem]">
            {runId}
          </code>
        )}
        <div
          className={`w-2.5 h-2.5 rounded-full ${
            autoRefresh ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/30'
          }`}
          title={autoRefresh ? 'Auto-refresh on' : 'Auto-refresh paused'}
        />
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {lastRefresh > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">
            Updated {(() => {
              try {
                return new Date(lastRefresh).toLocaleTimeString()
              } catch {
                return ''
              }
            })()}
          </span>
        )}
        <Button
          variant={autoRefresh ? 'default' : 'outline'}
          size="sm"
          onClick={() => setAutoRefresh(!autoRefresh)}
        >
          {autoRefresh ? 'Auto' : 'Paused'}
        </Button>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
    </div>
  )
}

// ── States ──────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3">
      <Loader />
      <p className="text-sm text-muted-foreground">Loading evidence…</p>
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
      <p className="text-sm text-destructive">Failed to load evidence</p>
      <p className="text-xs text-muted-foreground max-w-md break-words">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function EmptyState({ runId, onRetry }: { runId: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
      <p className="text-sm text-muted-foreground">
        No evidence found for run{' '}
        <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{runId}</code>
      </p>
      <p className="text-xs text-muted-foreground max-w-md">
        The bridge has no evidence record for this run id. It may not have
        completed yet, or the run id may be incorrect.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function NoFilesState({ runId }: { runId: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
      <p className="text-sm text-muted-foreground">No evidence files yet</p>
      <p className="text-xs text-muted-foreground max-w-md">
        The bridge returned a record for run{' '}
        <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{runId}</code>{' '}
        but it contains no files. Evidence is collected once the run finishes —
        try refreshing in a moment.
      </p>
    </div>
  )
}

function MissingFileBlock({
  label,
  filename,
  description,
}: {
  label: string
  filename: string
  description: string
}) {
  return (
    <section className="rounded-lg border border-dashed border-border bg-muted/10 overflow-hidden">
      <header className="px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-muted-foreground">{label}</h3>
          <span className="text-xs text-muted-foreground/70">— not produced</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </header>
      <div className="p-4">
        <code className="text-xs font-mono text-muted-foreground/70">{filename}</code>
        <p className="text-xs text-muted-foreground mt-1">
          This run did not generate this artifact.
        </p>
      </div>
    </section>
  )
}
