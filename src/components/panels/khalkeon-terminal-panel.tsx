'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon as FitAddonType } from '@xterm/addon-fit'
import { apiFetch, ApiError } from '@/lib/api-client'

/**
 * KhalkeonTerminalPanel
 * --------------------
 * Renders an xterm.js terminal attached to a running khalkeon agent tmux
 * session via the bridge WebSocket.
 *
 * Flow:
 *   1. Read `run_id` from the URL query string.
 *   2. POST /api/bridge/attach-token?run_id=... (server-side proxy holds the
 *      bridge bearer token) -> { token, run_id, expires_in_seconds }.
 *   3. Dynamically import @xterm/xterm + addons (client-only, SSR safe).
 *   4. Open ws://localhost:8000/attach/{run_id}?token=<short-lived>.
 *   5. Bridge -> client: { type: 'output', data } writes to the terminal.
 *      Client -> bridge: { type: 'input', data } on term.onData, and
 *      { type: 'resize', cols, rows } on fit/ResizeObserver.
 *   6. On unmount: close the WS, dispose the ResizeObserver and terminal.
 *
 * The bridge base URL is read from NEXT_PUBLIC_KHALKEON_BRIDGE_WS so the
 * browser knows where to open the socket (defaults to ws://localhost:8000).
 * The attach *token* is minted server-side and never baked into the build.
 */

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

interface AttachTokenResponse {
  token: string
  run_id: string
  expires_in_seconds: number
}

/**
 * Messages we send to the bridge over the attach socket.
 * Kept narrow and literal so the JSON shape is auditable.
 */
type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }

/**
 * Best-effort parse of an inbound bridge frame. The bridge sends
 * `{ type: 'output', data: string }` for tmux output; anything else is
 * treated as raw text and written verbatim (matches terminal-view.tsx).
 */
function tryParseBridgeFrame(raw: string): { type?: string; data?: string } | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'type' in parsed) {
      const obj = parsed as Record<string, unknown>
      const type = typeof obj.type === 'string' ? obj.type : undefined
      const data = typeof obj.data === 'string' ? obj.data : undefined
      return { type, data }
    }
    return null
  } catch {
    return null
  }
}

function KhalkeonTerminalPanelInner() {
  const t = useTranslations('khalkeonTerminal')
  const searchParams = useSearchParams()
  const runId = searchParams.get('run_id')?.trim() || null

  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddonType | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  const [connState, setConnState] = useState<ConnectionState>('connecting')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [tokenExpiry, setTokenExpiry] = useState<number | null>(null)

  const connect = useCallback(async (id: string) => {
    if (!containerRef.current) return

    setConnState('connecting')
    setErrorMessage(null)

    // Step 1: mint a short-lived attach token via the server-side proxy.
    // The bridge bearer token (KHALKEON_WEB_TOKEN) stays server-side.
    let tokenData: AttachTokenResponse
    try {
      tokenData = await apiFetch<AttachTokenResponse>(
        `/api/bridge/attach-token?run_id=${encodeURIComponent(id)}`,
        { method: 'POST' },
      )
    } catch (err) {
      setConnState('error')
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to mint attach token'
      setErrorMessage(msg)
      return
    }

    setTokenExpiry(tokenData.expires_in_seconds ?? null)

    // Step 2: load xterm.js + addons dynamically (heavy, client-only).
    const [xtermModule, fitModule, webLinksModule] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
    ])

    // Inject xterm CSS inline once (avoids Next.js CSS-module resolution).
    if (!document.querySelector('style[data-xterm-css]')) {
      const style = document.createElement('style')
      style.setAttribute('data-xterm-css', '1')
      style.textContent = `
        .xterm { position: relative; user-select: none; }
        .xterm.focus, .xterm:focus { outline: none; }
        .xterm .xterm-helpers { position: absolute; top: 0; z-index: 5; }
        .xterm .xterm-helper-textarea { padding: 0; border: 0; margin: 0; position: absolute; opacity: 0; left: -9999em; top: 0; width: 0; height: 0; z-index: -5; white-space: nowrap; overflow: hidden; resize: none; }
        .xterm .composition-view { display: none; position: absolute; white-space: nowrap; z-index: 1; }
        .xterm .xterm-viewport { background-color: transparent; overflow-y: scroll; cursor: default; position: absolute; right: 0; left: 0; top: 0; bottom: 0; }
        .xterm .xterm-screen { position: relative; }
        .xterm .xterm-screen canvas { position: absolute; left: 0; top: 0; }
        .xterm .xterm-scroll-area { visibility: hidden; }
        .xterm-char-measure-element { display: inline-block; visibility: hidden; position: absolute; top: 0; left: -9999em; line-height: normal; }
        .xterm.enable-mouse-events { cursor: default; }
        .xterm .xterm-cursor-pointer { cursor: pointer; }
        .xterm.column-select.focus { cursor: crosshair; }
        .xterm .xterm-accessibility:not(.debug), .xterm .xterm-message { position: absolute; left: 0; top: 0; bottom: 0; right: 0; z-index: 10; color: transparent; pointer-events: none; }
        .xterm .xterm-decoration-container .xterm-decoration { z-index: 6; position: absolute; }
        .xterm .xterm-decoration-container .xterm-decoration.xterm-decoration-top-layer { z-index: 7; }
        .xterm .xterm-decoration-overview-ruler { z-index: 8; position: absolute; top: 0; right: 0; pointer-events: none; }
        .xterm .xterm-decoration-top { z-index: 2; position: relative; }
      `
      document.head.appendChild(style)
    }

    const { Terminal: TerminalCtor } = xtermModule
    const { FitAddon: FitAddonCtor } = fitModule
    const { WebLinksAddon: WebLinksAddonCtor } = webLinksModule

    // Dispose a prior terminal if this effect re-ran.
    if (termRef.current) {
      try {
        termRef.current.dispose()
      } catch {
        /* ignore */
      }
      termRef.current = null
    }

    const term = new TerminalCtor({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 13,
      fontFamily:
        "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      lineHeight: 1.3,
      scrollback: 5000,
      theme: {
        background: '#0a0a0f',
        foreground: '#e4e4e7',
        cursor: '#22d3ee',
        cursorAccent: '#0a0a0f',
        selectionBackground: '#3f3f4680',
        selectionForeground: '#e4e4e7',
        black: '#18181b',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e4e4e7',
        brightBlack: '#52525b',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#fafafa',
      },
      allowProposedApi: true,
    })

    const fitAddon = new FitAddonCtor()
    const webLinksAddon = new WebLinksAddonCtor()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)

    termRef.current = term
    fitAddonRef.current = fitAddon

    term.open(containerRef.current)
    try {
      fitAddon.fit()
    } catch {
      /* container not laid out yet — ResizeObserver will retry */
    }
    term.scrollToBottom()

    // Step 3: open the WebSocket to the bridge attach endpoint.
    const wsBase =
      process.env.NEXT_PUBLIC_KHALKEON_BRIDGE_WS || 'ws://localhost:8000'
    const wsUrl = `${wsBase}/attach/${encodeURIComponent(id)}?token=${encodeURIComponent(tokenData.token)}`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setConnState('connected')
      // Send the initial viewport size so the bridge can resize tmux.
      if (ws.readyState === WebSocket.OPEN) {
        const init: ClientMessage = {
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }
        ws.send(JSON.stringify(init))
      }
    }

    ws.onmessage = (event) => {
      // xterm wants string data; the bridge sends JSON or raw text.
      const raw = typeof event.data === 'string' ? event.data : ''
      const parsed = tryParseBridgeFrame(raw)
      if (parsed?.type === 'output' && parsed.data !== undefined) {
        term.write(parsed.data)
        term.scrollToBottom()
      } else if (parsed === null && raw.length > 0) {
        // Raw text fallback — write verbatim.
        term.write(raw)
        term.scrollToBottom()
      }
    }

    ws.onclose = () => {
      setConnState((prev) => (prev === 'error' ? prev : 'disconnected'))
    }

    ws.onerror = () => {
      setConnState('error')
      setErrorMessage('WebSocket connection to bridge failed')
    }

    // Forward terminal input to the bridge.
    const onDataDisposable = term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        const msg: ClientMessage = { type: 'input', data }
        ws.send(JSON.stringify(msg))
      }
    })

    // Resize handling: observe the container and notify the bridge.
    const sendResize = () => {
      try {
        fitAddon.fit()
      } catch {
        /* ignore */
      }
      if (ws.readyState === WebSocket.OPEN) {
        const msg: ClientMessage = {
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }
        ws.send(JSON.stringify(msg))
      }
    }

    const resizeObserver = new ResizeObserver(() => sendResize())
    resizeObserver.observe(containerRef.current)
    resizeObserverRef.current = resizeObserver

    // Cleanup runs on unmount or when connect re-runs.
    return () => {
      onDataDisposable.dispose()
      resizeObserver.disconnect()
      resizeObserverRef.current = null
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
      wsRef.current = null
      try {
        term.dispose()
      } catch {
        /* ignore */
      }
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!runId) {
      setConnState('disconnected')
      return
    }
    const cleanupPromise = connect(runId)
    let cleanup: (() => void) | null = null

    cleanupPromise.then((fn) => {
      cleanup = fn ?? null
    })

    return () => {
      // If the async connect already resolved, run its cleanup.
      if (cleanup) cleanup()
      // Otherwise best-effort: tear down whatever refs are live.
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
        resizeObserverRef.current = null
      }
      if (wsRef.current) {
        try {
          wsRef.current.close()
        } catch {
          /* ignore */
        }
        wsRef.current = null
      }
      if (termRef.current) {
        try {
          termRef.current.dispose()
        } catch {
          /* ignore */
        }
        termRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  if (!runId) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
          <div className="text-2xl">🖥️</div>
          <h2 className="text-lg font-semibold text-zinc-100">
            {t('selectRunTitle') || 'Select a run'}
          </h2>
          <p className="text-sm text-zinc-400">
            {t('selectRunDescription') ||
              'No run_id provided. Open a run from the runs list to attach a live terminal to its tmux session.'}
          </p>
          <code className="inline-block mt-2 px-2 py-1 rounded bg-zinc-800/60 text-xs text-zinc-300">
            ?run_id=&lt;run-id&gt;
          </code>
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full min-h-[200px] bg-[#0a0a0f] rounded-lg overflow-hidden">
      <div
        ref={containerRef}
        className="h-full w-full"
        aria-label={t('terminalAria') || 'khalkeon agent terminal'}
      />

      {connState === 'connecting' && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0f]/90 z-10">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
            <p className="text-sm text-zinc-400">
              {t('connecting') || 'Connecting to agent session...'}
            </p>
          </div>
        </div>
      )}

      {connState === 'disconnected' && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0f]/90 z-10">
          <div className="flex flex-col items-center gap-3">
            <div className="text-2xl">🔌</div>
            <p className="text-sm text-zinc-400">
              {t('disconnected') || 'Disconnected from agent session'}
            </p>
            <button
              type="button"
              onClick={() => runId && connect(runId)}
              className="mt-1 px-3 py-1.5 rounded-md bg-cyan-500/20 text-cyan-300 text-xs hover:bg-cyan-500/30 transition-colors"
            >
              {t('reconnect') || 'Reconnect'}
            </button>
          </div>
        </div>
      )}

      {connState === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0f]/90 z-10">
          <div className="flex flex-col items-center gap-3 max-w-md text-center">
            <div className="text-2xl">⚠️</div>
            <p className="text-sm text-red-300">
              {errorMessage || (t('error') || 'Connection error')}
            </p>
            <button
              type="button"
              onClick={() => runId && connect(runId)}
              className="mt-1 px-3 py-1.5 rounded-md bg-red-500/20 text-red-300 text-xs hover:bg-red-500/30 transition-colors"
            >
              {t('retry') || 'Retry'}
            </button>
          </div>
        </div>
      )}

      {connState === 'connected' && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
          {tokenExpiry !== null && (
            <span className="px-2 py-0.5 rounded bg-zinc-800/80 text-[10px] text-zinc-400">
              token {Math.round(tokenExpiry / 60)}m
            </span>
          )}
          <span className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-green-500/20 text-green-300 text-[10px]">
            <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
            {t('connected') || 'live'}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * `useSearchParams` requires a Suspense boundary in Next.js App Router or the
 * entire page deopts to client-side rendering. Wrap the inner panel so the
 * panel can be embedded without forcing the host page to add its own boundary.
 */
export function KhalkeonTerminalPanel() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full w-full items-center justify-center bg-[#0a0a0f] rounded-lg">
          <div className="h-8 w-8 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
        </div>
      }
    >
      <KhalkeonTerminalPanelInner />
    </Suspense>
  )
}
