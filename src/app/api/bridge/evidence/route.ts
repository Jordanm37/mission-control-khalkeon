import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * GET /api/bridge/evidence?run_id=<run_id>
 *
 * Proxies GET /evidence/{run_id} on the khalkeon bridge (the execution plane
 * that collects the artifacts a finished run produced). The dashboard cannot
 * call localhost:8000 directly from the browser — same-origin restrictions and
 * the bearer token in KHALKEON_WEB_TOKEN must stay server-side — so this route
 * forwards the request with the token attached and relays the JSON payload back.
 *
 * Expected bridge response:
 *   {
 *     run_id: string,
 *     evidence: {
 *       "tests.log"?: string,
 *       "diff.summary"?: string,
 *       "pr_url.txt"?: string,
 *       "lint.log"?: string,
 *       ...other files
 *     }
 *   }
 *
 * Error mapping:
 *   missing run_id query param            -> 400
 *   bridge unreachable / network failure  -> 502 (bad gateway)
 *   bridge returns 401 / 403              -> 401 (auth failure on the bridge)
 *   bridge returns 404 (run not found)    -> 404
 *   any other upstream non-2xx            -> 502
 *   payload shape mismatch                -> 502
 */

const DEFAULT_BRIDGE_URL = 'http://localhost:8000'
const FETCH_TIMEOUT_MS = 5_000

type EvidenceMap = Record<string, string>

interface BridgeEvidenceResponse {
  run_id: string
  evidence: EvidenceMap
}

function isBridgeEvidenceResponse(value: unknown): value is BridgeEvidenceResponse {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.run_id !== 'string') return false
  if (!v.evidence || typeof v.evidence !== 'object') return false
  // Every evidence value must be a string (file contents). Unknown keys are
  // tolerated as long as the shape is string→string.
  return Object.values(v.evidence).every((val) => typeof val === 'string')
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const { searchParams } = new URL(request.url)
  const runId = searchParams.get('run_id')?.trim()

  if (!runId) {
    return NextResponse.json(
      { error: 'Missing required query parameter: run_id' },
      { status: 400 },
    )
  }

  const bridgeUrl = (process.env.KHALKEON_BRIDGE_URL ?? DEFAULT_BRIDGE_URL).replace(/\/$/, '')
  const token = process.env.KHALKEON_WEB_TOKEN

  if (!token) {
    logger.error(
      { bridgeUrl },
      'GET /api/bridge/evidence: KHALKEON_WEB_TOKEN is not configured',
    )
    return NextResponse.json(
      { error: 'Bridge token is not configured on the server' },
      { status: 500 },
    )
  }

  const upstream = `${bridgeUrl}/evidence/${encodeURIComponent(runId)}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(upstream, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    })
  } catch (err) {
    clearTimeout(timeout)
    const reason = err instanceof Error ? err.name : 'UnknownError'
    logger.error(
      { err, upstream, reason, runId },
      'GET /api/bridge/evidence: bridge unreachable',
    )
    return NextResponse.json(
      { error: 'khalkeon bridge is unreachable', upstream },
      { status: 502 },
    )
  } finally {
    clearTimeout(timeout)
  }

  // Auth failure on the bridge — relay as 401 so the panel can surface it.
  if (res.status === 401 || res.status === 403) {
    const body = await res.json().catch(() => null)
    logger.warn(
      { upstream, status: res.status, runId },
      'GET /api/bridge/evidence: bridge rejected authorization',
    )
    return NextResponse.json(
      { error: 'bridge rejected authorization', detail: body },
      { status: 401 },
    )
  }

  // Run not found on the bridge — relay as 404 so the panel can show the
  // "no evidence yet" state distinctly from a transport failure.
  if (res.status === 404) {
    logger.info(
      { upstream, runId },
      'GET /api/bridge/evidence: bridge has no evidence for run_id',
    )
    return NextResponse.json(
      { error: 'No evidence found for run_id', run_id: runId },
      { status: 404 },
    )
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    logger.error(
      { upstream, status: res.status, text, runId },
      'GET /api/bridge/evidence: bridge returned non-2xx',
    )
    return NextResponse.json(
      { error: 'bridge returned an error', status: res.status, detail: text },
      { status: 502 },
    )
  }

  const payload: unknown = await res.json().catch(() => null)
  if (!isBridgeEvidenceResponse(payload)) {
    logger.error(
      { upstream, runId, payload },
      'GET /api/bridge/evidence: bridge payload did not match expected shape',
    )
    return NextResponse.json(
      { error: 'bridge returned an unexpected evidence payload' },
      { status: 502 },
    )
  }

  return NextResponse.json(payload)
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
