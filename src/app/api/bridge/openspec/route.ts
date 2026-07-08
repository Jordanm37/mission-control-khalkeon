import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'

/**
 * Bridge proxy for the khalkeon bridge's OpenSpec endpoints.
 *
 * The MC frontend cannot call http://localhost:8000 directly from the browser
 * (mixed-origin / no cookies), so this server-side route forwards the request
 * and returns the bridge's JSON untouched.
 *
 *   GET /api/bridge/openspec/changes?project=<name>
 *     -> proxies to BRIDGE_URL/openspec/changes?project=<name>
 *        -> { changes: [...], dry_run: bool }
 */

const BRIDGE_URL = process.env.KHALKEON_BRIDGE_URL || 'http://localhost:8000'

// Bridge fetch timeout. The OpenSpec changes list is a cheap read; if the
// bridge takes longer than this we treat it as unreachable and surface a
// 502 so the panel can show an error instead of hanging on a skeleton.
const BRIDGE_TIMEOUT_MS = 8000

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const project = url.searchParams.get('project')

  const target = new URL(`${BRIDGE_URL}/openspec/changes`)
  if (project) target.searchParams.set('project', project)

  try {
    const upstream = await fetchWithTimeout(target.toString(), BRIDGE_TIMEOUT_MS)

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '')
      logger.warn(
        { status: upstream.status, body: body.slice(0, 500) },
        `bridge/openspec upstream ${upstream.status} for ${target.pathname}`
      )
      return NextResponse.json(
        { error: `Bridge returned ${upstream.status}`, detail: body.slice(0, 1000) },
        { status: upstream.status }
      )
    }

    // Pass the JSON through verbatim; the panel owns the shape contract.
    const data = await upstream.json().catch(() => null)
    if (data === null) {
      return NextResponse.json(
        { error: 'Bridge returned a non-JSON response' },
        { status: 502 }
      )
    }
    return NextResponse.json(data)
  } catch (err) {
    // Abort (timeout) or network failure — both mean the bridge is unreachable.
    const aborted = err instanceof Error && err.name === 'AbortError'
    const message = aborted
      ? `Bridge did not respond within ${BRIDGE_TIMEOUT_MS}ms`
      : 'Could not reach the khalkeon bridge'
    logger.error({ err: err }, 'bridge/openspec proxy failed')
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
