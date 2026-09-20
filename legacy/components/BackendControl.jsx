import { useCallback, useEffect, useState } from 'react'
import { Play, RefreshCw, Server, Square, Terminal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

function getTauriInvoke() {
  return window.__TAURI__?.core?.invoke || window.__TAURI__?.tauri?.invoke || null
}

function formatError(error) {
  if (!error) return 'Unknown backend error'
  if (typeof error === 'string') return error
  return error.message || String(error)
}

export default function BackendControl() {
  const [isTauri, setIsTauri] = useState(false)
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState({ running: false, message: 'Checking backend status...' })
  const [busy, setBusy] = useState(false)

  const runBackendCommand = useCallback(async (command) => {
    const invoke = getTauriInvoke()
    if (!invoke) return

    setBusy(true)
    try {
      const nextStatus = await invoke(command)
      setStatus(nextStatus)
    } catch (error) {
      setStatus({ running: false, message: formatError(error) })
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    const invoke = getTauriInvoke()
    setIsTauri(Boolean(invoke))
  }, [])

  useEffect(() => {
    if (!isTauri) return
    runBackendCommand('backend_status')
    const interval = window.setInterval(() => runBackendCommand('backend_status'), 5000)
    return () => window.clearInterval(interval)
  }, [isTauri, runBackendCommand])

  if (!isTauri) return null

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="icon"
        onClick={() => setOpen(value => !value)}
        className={status.running ? 'border-green-500/50 text-green-400' : 'border-amber-500/50 text-amber-300'}
        title="Python backend"
      >
        <Server className="h-4 w-4" />
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-[9998] mt-2 w-[380px] rounded-xl border border-border bg-card/95 p-3 text-card-foreground shadow-2xl backdrop-blur">
          <div className="mb-3 flex items-start gap-2">
            <div className={`mt-0.5 rounded-full p-2 ${status.running ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-300'}`}>
              <Server className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">Python Backend</div>
                <button className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setOpen(false)}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{status.message}</div>
              {status.managed && (
                <div className="mt-1 text-[11px] text-green-400">Managed by this app</div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => runBackendCommand('start_backend')} disabled={busy || status.running}>
              <Play className="mr-1 h-3.5 w-3.5" /> Start
            </Button>
            <Button size="sm" variant="outline" onClick={() => runBackendCommand('stop_backend')} disabled={busy}>
              <Square className="mr-1 h-3.5 w-3.5" /> Stop
            </Button>
            <Button size="sm" variant="outline" onClick={() => runBackendCommand('open_backend_terminal')} disabled={busy}>
              <Terminal className="mr-1 h-3.5 w-3.5" /> Terminal
            </Button>
            <Button size="sm" variant="outline" onClick={() => runBackendCommand('backend_status')} disabled={busy}>
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} /> Check
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
