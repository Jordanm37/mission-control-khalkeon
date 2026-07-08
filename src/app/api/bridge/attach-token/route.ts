import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * Bridge proxy: POST /api/bridge/attach-token?run_id=<run_id>
 *
 * Forwards to the khalkeon bridge at ${KHALKEON_BRIDGE_URL}/attach-token/{run_id}
 * to mint a short-lived attach token (5 minute TTL on the bridge) that the
 * browser then uses to open the WS at /attach/{run_id}?token=...
 *
 * The bridge auth token (KHALKEON_WEB_TOKEN) is held server-side and never
 * reaches the browser. The returned { token, run_id, expires_in_seconds } is
 * forwarded as-is so the panel can wire up the WebSocket.
 */

export async function POST(request: NextRequest) {
  // Gate on the MC session first so only authenticated dashboard users can
  // mint attach tokens.
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

  const bridgeUrl = process.env.KHALKEON_BRIDGE_URL || 'http://localhost:8000'
  const bridgeToken = process.env.KHALKEON_WEB_TOKEN

  if (!bridgeToken) {
    logger.error(
      { bridgeUrl },
      'attach-token proxy: KHALKEON_WEB_TOKEN is not set; refusing to proxy without bridge auth',
    )
    return NextResponse.json(
      { error: 'Bridge auth not configured (KHALKEON_WEB_TOKEN missing)' },
      { status: 500 },
    )
  }

  // Decode the run_id before interpolation: the query string may contain a
  // URL-encoded value, and the bridge expects the raw run id in the path.
  const upstreamUrl = `${bridgeUrl}/attach-token/${encodeURIComponent(runId)}`

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridgeToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      // The bridge mints a token regardless of body, but forward an empty
      // JSON object so a bridge that expects a body does not 400.
      body: JSON.stringify({}),
      cache: 'no-store',
    })

    if (upstream.status === 401 || upstream.status === 403) {
      logger.warn(
        { status: upstream.status, runId },
        'attach-token proxy: bridge rejected auth',
      )
      return NextResponse.json(
        { error: 'Bridge rejected authorization' },
        { status: 401 },
      )
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      logger.error(
        { status: upstream.status, runId, body: text.slice(0, 500) },
        'attach-token proxy: bridge returned non-2xx',
      )
      return NextResponse.json(
        { error: `Bridge error (${upstream.status})` },
        { status: 502 },
      )
    }

    const data = await upstream.json()
    return NextResponse.json(data, { status: 200 })
  } catch (err) {
    logger.error(
      { err, upstreamUrl, runId },
      'attach-token proxy: failed to reach bridge',
    )
    return NextResponse.json(
      { error: 'Bridge unreachable' },
      { status: 502 },
    )
  }
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
