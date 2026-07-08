import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * GET /api/bridge/runs?state=...&project=...
 *
 * Proxies GET /runs on the khalkeon bridge (the execution plane that owns the
 * live run registry). The dashboard cannot call localhost:8000 directly from
 * the browser — same-origin restrictions and the bearer token in
 * KHALKEON_WEB_TOKEN must stay server-side — so this route forwards the
 * request with the token attached and relays the JSON payload back.
 *
 * Query params (forwarded): state, project — both optional.
 *
 * Expected bridge response:
 *   { runs: Array<{ run_id, state, project, ... }>, count: number }
 *
 * Error mapping (aligned with src/app/api/bridge/agents/route.ts):
 *   KHALKEON_WEB_TOKEN unset                   -> 500 (misconfigured server)
 *   bridge unreachable / network failure       -> 502 (bad gateway)
 *   bridge returns 401 / 403                   -> 401 (auth failure on the bridge)
 *   any other upstream non-2xx                 -> 502
 *   payload shape mismatch                     -> 502
 */

const DEFAULT_BRIDGE_URL = 'http://localhost:8000'
const FETCH_TIMEOUT_MS = 5_000

type BridgeRun = {
  run_id: string
  state: string
  project?: string
  [key: string]: unknown
}

type BridgeRunsResponse = {
  runs: BridgeRun[]
  count: number
}

function isBridgeRunsResponse(value: unknown): value is BridgeRunsResponse {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.runs)) return false
  if (typeof v.count !== 'number') return false
  return v.runs.every(
    (r) => r && typeof r === 'object' &&
      typeof (r as Record<string, unknown>).run_id === 'string' &&
      typeof (r as Record<string, unknown>).state === 'string',
  )
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const bridgeUrl = (process.env.KHALKEON_BRIDGE_URL ?? DEFAULT_BRIDGE_URL).replace(/\/$/, '')
  const token = process.env.KHALKEON_WEB_TOKEN

  if (!token) {
    logger.error(
      { bridgeUrl },
      'GET /api/bridge/runs: KHALKEON_WEB_TOKEN is not configured',
    )
    return NextResponse.json(
      { error: 'Bridge token is not configured on the server' },
      { status: 500 },
    )
  }

  // Forward only the supported filter params; drop anything else.
  const { searchParams } = new URL(request.url)
  const fwd = new URLSearchParams()
  const state = searchParams.get('state')
  const project = searchParams.get('project')
  if (state) fwd.set('state', state)
  if (project) fwd.set('project', project)
  const qs = fwd.toString()
  const upstream = `${bridgeUrl}/runs${qs ? `?${qs}` : ''}`

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
      { err, upstream, reason },
      'GET /api/bridge/runs: bridge unreachable',
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
      { upstream, status: res.status },
      'GET /api/bridge/runs: bridge rejected authorization',
    )
    return NextResponse.json(
      { error: 'bridge rejected authorization', detail: body },
      { status: 401 },
    )
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    logger.error(
      { upstream, status: res.status, text },
      'GET /api/bridge/runs: bridge returned non-2xx',
    )
    return NextResponse.json(
      { error: 'bridge returned an error', status: res.status, detail: text },
      { status: 502 },
    )
  }

  const payload: unknown = await res.json().catch(() => null)
  if (!isBridgeRunsResponse(payload)) {
    logger.error(
      { upstream, payload },
      'GET /api/bridge/runs: bridge payload did not match expected shape',
    )
    return NextResponse.json(
      { error: 'bridge returned an unexpected payload shape' },
      { status: 502 },
    )
  }

  return NextResponse.json(payload)
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
