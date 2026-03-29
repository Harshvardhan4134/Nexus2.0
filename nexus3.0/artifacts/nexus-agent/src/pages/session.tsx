import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useRoute, useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity, Globe, Square, AlertCircle, CheckCircle2,
  ChevronRight, MessageSquare, ShieldAlert, Monitor,
  Eye, MousePointer, Keyboard, Navigation, Search, FileText, Play,
  Copy, ExternalLink, Send,
} from 'lucide-react';
import {
  useGetSession,
  useStopSession,
  useSendInput,
  getGetSessionQueryKey,
  type SessionDetail,
  type SessionDetailBrowserSurface,
} from '@workspace/api-client-react';
import { Button, Badge, Input } from '@/components/ui-elements';
import { formatTime } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface FrameData {
  frameBase64: string;
  url: string;
  title: string;
  timestamp: number;
}

/** Playwright viewport — must match live-browser.ts VIEWPORT for click mapping */
const PW_VIEW_W = 1280;
const PW_VIEW_H = 720;

function apiOrigin(): string {
  return (import.meta.env.VITE_API_ORIGIN as string | undefined)?.trim().replace(/\/$/, '') ?? '';
}

/** Absolute or same-origin path for API calls (matches EventSource). */
function apiUrl(path: string): string {
  const o = apiOrigin();
  if (!o) return path;
  return `${o}${path.startsWith('/') ? path : `/${path}`}`;
}

function agentStreamUrl(sessionId: string): string {
  return apiUrl(`/api/agent/sessions/${encodeURIComponent(sessionId)}/stream`);
}

async function postInteractClick(sessionId: string, x: number, y: number): Promise<void> {
  await fetch(apiUrl(`/api/agent/sessions/${encodeURIComponent(sessionId)}/interact/click`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y }),
  });
}

async function postInteractText(sessionId: string, text: string): Promise<void> {
  await fetch(apiUrl(`/api/agent/sessions/${encodeURIComponent(sessionId)}/interact/key`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

function waitingForBrowserCopy(surface: SessionDetailBrowserSurface | undefined) {
  const s: SessionDetailBrowserSurface = surface ?? 'headless';
  const remote = (
    <>
      {' '}Use <strong>Send to browser</strong> below to type into the field you clicked in the preview, then tap{' '}
      <strong>Resume</strong>.
    </>
  );
  if (s === 'cdp') {
    return (
      <>
        Nexus is using <strong>your Chrome</strong> (remote debugging tab). Prefer signing in there, or{' '}
        <strong>click the preview</strong> to click inside the page and send text below.{remote}
      </>
    );
  }
  if (s === 'headed') {
    return (
      <>
        Prefer the <strong>Chromium window</strong> on this PC, or <strong>click the preview</strong> and use{' '}
        <strong>Send to browser</strong> below.{remote}
      </>
    );
  }
  return (
    <>
      The preview is a <strong>screenshot stream</strong>, not a normal browser tab — you cannot type directly into it.{' '}
      <strong>Click the image</strong> where you want to click (e.g. the email box), then type your email in{' '}
      <strong>Send to browser</strong> and press Send. Copy the full URL from the bar above if needed. If the preview
      stays blank, set <span className="font-mono text-[10px]">VITE_API_ORIGIN=http://127.0.0.1:8080</span> in{' '}
      <span className="font-mono text-[10px]">.env</span> or run the API with{' '}
      <span className="font-mono text-[10px]">NEXUS_HEADED_BROWSER=1</span>.
    </>
  );
}

function LiveBrowserView({ sessionId, isRunning }: { sessionId: string; isRunning: boolean }) {
  const [frame, setFrame] = useState<FrameData | null>(null);
  const [connected, setConnected] = useState(false);
  const [streamFaults, setStreamFaults] = useState(0);
  const [remoteText, setRemoteText] = useState('');
  const [sending, setSending] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!sessionId) return;

    const connect = () => {
      const url = agentStreamUrl(sessionId);
      const es = new EventSource(url);
      esRef.current = es;

      es.addEventListener('frame', (e) => {
        try {
          const data = JSON.parse(e.data) as FrameData;
          setFrame(data);
          setConnected(true);
          setStreamFaults(0);
        } catch { /* ignore */ }
      });

      es.addEventListener('status', () => {
        setConnected(true);
      });

      es.onerror = () => {
        setStreamFaults((n) => n + 1);
        es.close();
        setTimeout(() => {
          if (esRef.current === es) connect();
        }, 1500);
      };
    };

    setStreamFaults(0);
    connect();
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, [sessionId]);

  const copyPageUrl = useCallback(async () => {
    const u = frame?.url;
    if (!u) return;
    try {
      await navigator.clipboard.writeText(u);
    } catch {
      /* ignore */
    }
  }, [frame?.url]);

  const openPageExternally = useCallback(() => {
    const u = frame?.url;
    if (u) window.open(u, '_blank', 'noopener,noreferrer');
  }, [frame?.url]);

  const mapPointerToViewport = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = imgRef.current;
    if (!el?.naturalWidth || !el.naturalHeight) return null;
    const r = el.getBoundingClientRect();
    const scale = Math.min(r.width / el.naturalWidth, r.height / el.naturalHeight);
    const dw = el.naturalWidth * scale;
    const dh = el.naturalHeight * scale;
    const ox = r.left + (r.width - dw) / 2;
    const oy = r.top + (r.height - dh) / 2;
    const px = clientX - ox;
    const py = clientY - oy;
    if (px < 0 || py < 0 || px > dw || py > dh) return null;
    return {
      x: Math.round((px / dw) * PW_VIEW_W),
      y: Math.round((py / dh) * PW_VIEW_H),
    };
  }, []);

  const onImagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLImageElement>) => {
      if (!isRunning || !frame) return;
      const mapped = mapPointerToViewport(e.clientX, e.clientY);
      if (!mapped) return;
      e.preventDefault();
      void postInteractClick(sessionId, mapped.x, mapped.y);
    },
    [isRunning, frame, mapPointerToViewport, sessionId],
  );

  const sendRemoteText = useCallback(async () => {
    const t = remoteText.trim();
    if (!t || !sessionId) return;
    setSending(true);
    try {
      await postInteractText(sessionId, t);
      setRemoteText('');
    } finally {
      setSending(false);
    }
  }, [remoteText, sessionId]);

  const hostname =
    frame?.url &&
    (() => {
      try {
        return new URL(frame.url).hostname;
      } catch {
        return frame.url.slice(0, 48);
      }
    })();

  return (
    <div className="relative w-full bg-black rounded-xl overflow-hidden border border-white/10 shadow-2xl">
      <div className="flex items-center gap-2 px-3 py-2 bg-[#1a1a1a] border-b border-white/10">
        <div className="flex gap-1.5 shrink-0">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
          <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
          <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
        </div>
        <div
          className="flex-1 min-w-0 mx-1 bg-black/50 rounded-md px-2 py-0.5 text-[10px] text-white/50 font-mono truncate border border-white/5"
          title={frame?.url || undefined}
        >
          {hostname || '…'}
        </div>
        {frame?.url ? (
          <div className="flex items-center gap-0.5 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-white/50 hover:text-white"
              title="Copy page URL"
              onClick={() => void copyPageUrl()}
            >
              <Copy className="w-3.5 h-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-white/50 hover:text-white"
              title="Open in your browser (won’t share Nexus login)"
              onClick={openPageExternally}
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </Button>
          </div>
        ) : null}
        <div className="flex items-center gap-1 shrink-0">
          {isRunning && connected && (
            <span className="flex items-center gap-1 text-[9px] text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              LIVE
            </span>
          )}
          <Monitor className="w-3 h-3 text-white/20" />
        </div>
      </div>

      {frame?.url ? (
        <div className="px-2 py-1.5 bg-[#0c0c0c] border-b border-white/5">
          <p className="text-[9px] text-white/55 font-mono break-all leading-relaxed select-text">{frame.url}</p>
        </div>
      ) : null}

      <div className="relative w-full bg-black" style={{ aspectRatio: '16/9' }}>
        {frame ? (
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${frame.frameBase64}`}
            alt="Live browser — click to forward clicks to the automated browser"
            className={cn(
              'w-full h-full object-contain select-none touch-manipulation',
              isRunning && 'cursor-crosshair',
            )}
            style={{ imageRendering: 'auto' }}
            draggable={false}
            onPointerDown={onImagePointerDown}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0d0d0d] px-4 text-center">
            {isRunning ? (
              <>
                <div className="w-8 h-8 rounded-full border-2 border-primary/20 border-t-primary animate-spin mb-3" />
                <p className="text-xs text-white/30">Starting browser…</p>
                {streamFaults >= 3 && (
                  <p className="text-[10px] text-amber-200/80 mt-3 max-w-sm leading-relaxed">
                    Live stream is not reaching this page. Confirm the API is running on port{' '}
                    <span className="font-mono">8080</span>, restart the agent dev server, or set{' '}
                    <span className="font-mono">VITE_API_ORIGIN=http://127.0.0.1:8080</span> in{' '}
                    <span className="font-mono">.env</span> so the stream connects directly (bypasses the Vite proxy).
                  </p>
                )}
              </>
            ) : (
              <>
                <Monitor className="w-8 h-8 text-white/10 mb-2" />
                <p className="text-xs text-white/20">No browser session</p>
              </>
            )}
          </div>
        )}

        {frame && isRunning && (
          <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/70 rounded-md px-1.5 py-0.5 text-[9px] text-white/40 border border-white/10 pointer-events-none">
            <Eye className="w-2.5 h-2.5" />
            {frame.title ? frame.title.slice(0, 30) : 'Loading...'}
          </div>
        )}
      </div>

      {isRunning && frame ? (
        <div className="px-3 py-2 border-t border-white/10 bg-[#111] space-y-1.5">
          <p className="text-[10px] text-white/45 leading-snug">
            Click the picture to click inside Nexus’s browser. Use this field to type into the focused box (email,
            password), then Send.
          </p>
          <div className="flex gap-2">
            <Input
              value={remoteText}
              onChange={(e) => setRemoteText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void sendRemoteText();
              }}
              placeholder="Type here → sent to automated browser…"
              className="text-xs flex-1 h-9"
            />
            <Button
              type="button"
              size="sm"
              className="shrink-0 h-9 px-3"
              disabled={sending || !remoteText.trim()}
              isLoading={sending}
              onClick={() => void sendRemoteText()}
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChromeExtensionPanel({ session }: { session: SessionDetail }) {
  return (
    <div className="rounded-xl border border-emerald-500/25 bg-emerald-950/30 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-emerald-500/20 bg-emerald-950/50">
        <Globe className="w-4 h-4 text-emerald-400" />
        <span className="text-xs font-medium text-emerald-200">Your Chrome (extension)</span>
        <span className="text-[10px] text-white/35 ml-auto">No Playwright</span>
      </div>
      <div className="p-3 space-y-2 text-[11px] text-white/65 leading-relaxed">
        <p>
          This task runs in <strong>your</strong> Chrome profile. The Nexus extension long-polls the API,
          claims this session, and runs the automation in the <strong>active tab</strong> (navigating to Gmail or
          LinkedIn when needed).
        </p>
        <p className="text-white/45">
          API default: <span className="font-mono text-[10px]">http://127.0.0.1:8080</span>
          — set <span className="font-mono text-[10px]">apiBaseUrl</span> in extension storage if different. Optional
          header: <span className="font-mono text-[10px]">NEXUS_EXTENSION_SECRET</span> matches{' '}
          <span className="font-mono text-[10px]">extensionSecret</span> in storage.
        </p>
        {session.currentUrl ? (
          <p className="font-mono text-[10px] text-white/50 break-all border border-white/10 rounded-lg p-2 bg-black/40">
            {session.currentUrl}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ActionIcon({ action }: { action: string }) {
  const a = action.toLowerCase();
  if (a === 'navigate') return <Navigation className="w-3 h-3" />;
  if (a === 'click') return <MousePointer className="w-3 h-3" />;
  if (a === 'type') return <Keyboard className="w-3 h-3" />;
  if (a === 'extract') return <FileText className="w-3 h-3" />;
  if (a === 'search') return <Search className="w-3 h-3" />;
  return <Activity className="w-3 h-3" />;
}

export default function SessionView() {
  const [, params] = useRoute('/session/:id');
  const [, setLocation] = useLocation();
  const sessionId = params?.id || '';

  const bottomRef = useRef<HTMLDivElement>(null);
  const [userInput, setUserInput] = useState('');
  const [activeTab, setActiveTab] = useState<'browser' | 'logs'>('browser');
  const [resumePending, setResumePending] = useState(false);

  const { data: session, isLoading, refetch } = useGetSession(sessionId, {
    query: {
      queryKey: getGetSessionQueryKey(sessionId),
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return (
          status === 'running' ||
          status === 'waiting_for_input' ||
          status === 'waiting_for_user'
        )
          ? 1500
          : false;
      },
    },
  });

  const stopMutation = useStopSession();
  const inputMutation = useSendInput();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.logs?.length, session?.actions?.length]);

  const handleResumeBrowser = useCallback(async () => {
    setResumePending(true);
    try {
      const r = await fetch(
        `/api/agent/sessions/${encodeURIComponent(sessionId)}/resume`,
        { method: 'POST' },
      );
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || r.statusText);
      }
      await refetch();
    } catch (e) {
      console.error(e);
    } finally {
      setResumePending(false);
    }
  }, [sessionId, refetch]);

  if (isLoading && !session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="w-10 h-10 rounded-full border-2 border-primary/20 border-t-primary animate-spin mb-4" />
        <p className="text-sm text-muted-foreground">Loading session…</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <ShieldAlert className="w-12 h-12 text-destructive mb-4" />
        <h2 className="text-xl font-bold mb-2">Session Not Found</h2>
        <Button variant="glass" size="sm" onClick={() => setLocation('/')}>Go Home</Button>
      </div>
    );
  }

  const isRunning = session.status === 'running';
  const extensionMode = session.extensionMode === true;
  /** Backend uses this while Playwright is paused in waitForUser (login, review, etc.) */
  const isWaitingForBrowser =
    !extensionMode &&
    (session.status === 'waiting_for_user' ||
      Boolean((session as { waitingForUser?: boolean }).waitingForUser));
  const isWaitingForChatInput = session.status === 'waiting_for_input';
  const isFinished = ['completed', 'error', 'stopped'].includes(session.status);

  /** Live stream + chrome: keep "live" while agent waits so you can log in in-frame */
  const showLiveActivity = isRunning || isWaitingForBrowser;

  const handleStop = () => stopMutation.mutate({ sessionId });
  const handleSendInput = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userInput.trim()) return;
    inputMutation.mutate({ sessionId, data: { input: userInput, confirmed: true } }, {
      onSuccess: () => setUserInput('')
    });
  };

  const allLogs = [...(session.logs ?? []), ...(session.actions?.map(a => ({
    timestamp: a.timestamp,
    level: a.status === 'error' ? 'error' : 'info' as 'info' | 'error',
    message: `[${a.action.toUpperCase()}] ${a.result || JSON.stringify(a.params || {})}`,
    isAction: true,
    actionStatus: a.status,
    usedVision: (a as { usedVision?: boolean }).usedVision,
  })) ?? [])].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-white/5 bg-black/40 backdrop-blur-md shrink-0">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <Badge
              variant={
                isRunning
                  ? 'default'
                  : isWaitingForBrowser || isWaitingForChatInput
                    ? 'warning'
                    : session.status === 'completed'
                      ? 'success'
                      : session.status === 'error'
                        ? 'error'
                        : 'outline'
              }
              className="mb-1.5 text-[9px] uppercase tracking-wider"
            >
              {(isRunning || isWaitingForBrowser) && (
                <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse mr-1" />
              )}
              {session.status.replace(/_/g, ' ')}
            </Badge>
            <h2 className="text-sm font-medium text-white leading-snug line-clamp-2">{session.task}</h2>
          </div>
          {(isRunning || isWaitingForBrowser) && (
            <Button
              variant="destructive"
              size="icon"
              className="w-8 h-8 rounded-xl shrink-0"
              onClick={handleStop}
              isLoading={stopMutation.isPending}
              title="Stop"
            >
              {!stopMutation.isPending && <Square className="w-3.5 h-3.5 fill-current" />}
            </Button>
          )}
        </div>

        {session.currentUrl && (
          <div className="flex items-start gap-1.5 text-[10px] text-white/45 bg-white/5 px-2 py-1.5 rounded-lg border border-white/5">
            <Globe className="w-3 h-3 shrink-0 text-primary/70 mt-0.5" />
            <span className="font-mono break-all leading-relaxed flex-1 min-w-0 select-text">{session.currentUrl}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-white/40 hover:text-white"
              title="Copy URL"
              onClick={() => void navigator.clipboard.writeText(session.currentUrl ?? '')}
            >
              <Copy className="w-3 h-3" />
            </Button>
          </div>
        )}

        {/* Tab switcher */}
        <div className="flex gap-1 mt-3">
          {(['browser', 'logs'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "px-3 py-1 rounded-lg text-xs font-medium transition-all capitalize",
                activeTab === tab
                  ? "bg-white/10 text-white"
                  : "text-white/40 hover:text-white/60"
              )}
            >
              {tab === 'browser' ? '🖥 Live Browser' : '📋 Logs'}
            </button>
          ))}
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          {activeTab === 'browser' ? (
            <motion.div
              key="browser"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="p-3"
            >
              {extensionMode ? (
                <ChromeExtensionPanel session={session} />
              ) : (
                <LiveBrowserView sessionId={sessionId} isRunning={showLiveActivity} />
              )}

              {/* Recent actions below the browser */}
              {session.actions && session.actions.length > 0 && (
                <div className="mt-3 space-y-1">
                  {session.actions.slice(-5).map((action, i) => (
                    <motion.div
                      key={action.timestamp + i}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-start gap-2 px-2 py-1.5 rounded-lg bg-white/3 border border-white/5"
                    >
                      <div className={cn(
                        "mt-0.5 p-1 rounded-md",
                        action.status === 'success' ? "bg-emerald-500/10 text-emerald-400" :
                        action.status === 'error' ? "bg-red-500/10 text-red-400" :
                        "bg-white/5 text-white/30"
                      )}>
                        <ActionIcon action={action.action} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] font-semibold text-white/80 capitalize">{action.action}</span>
                          {(action as { usedVision?: boolean }).usedVision && (
                            <span className="text-[9px] bg-violet-500/20 text-violet-300 px-1 py-0.5 rounded border border-violet-500/20">
                              <Eye className="w-2 h-2 inline mr-0.5" />vision
                            </span>
                          )}
                        </div>
                        {action.result && (
                          <p className="text-[10px] text-white/40 truncate">{action.result}</p>
                        )}
                      </div>
                      <span className="text-[9px] text-white/20 shrink-0">{formatTime(action.timestamp)}</span>
                    </motion.div>
                  ))}
                </div>
              )}

              {showLiveActivity && !isWaitingForBrowser && (
                <div className="flex items-center gap-2 mt-3 px-2 py-2 text-xs text-white/40">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary animate-ping" />
                  Agent working...
                </div>
              )}
              {isWaitingForBrowser && (
                <p className="mt-3 px-2 text-[11px] text-amber-200/90 leading-relaxed border border-amber-500/20 rounded-lg bg-amber-500/5 py-2">
                  {waitingForBrowserCopy(session.browserSurface)}
                </p>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="logs"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="p-3 space-y-1 pb-24"
            >
              <AnimatePresence initial={false}>
                {allLogs.map((log, i) => (
                  <motion.div
                    key={log.timestamp + i}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    className={cn(
                      "flex items-start gap-2 px-2 py-1.5 rounded-md text-[11px] font-mono",
                      log.level === 'error' ? "bg-red-500/5 border border-red-500/10 text-red-300" :
                      log.level === 'warn' ? "text-amber-300/70" :
                      log.level === 'debug' ? "text-white/20" :
                      "text-white/60"
                    )}
                  >
                    <span className="text-white/20 shrink-0 text-[9px] pt-0.5">{formatTime(log.timestamp)}</span>
                    <span className="leading-relaxed">{log.message}</span>
                  </motion.div>
                ))}
                {showLiveActivity && !isWaitingForBrowser && (
                  <motion.div
                    animate={{ opacity: [0.3, 0.7, 0.3] }}
                    transition={{ repeat: Infinity, duration: 1.5 }}
                    className="text-[11px] font-mono text-primary/60 px-2 py-1"
                  >
                    ▊ running...
                  </motion.div>
                )}
              </AnimatePresence>
              <div ref={bottomRef} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom bar — chat input, browser resume, or finished */}
      {(isWaitingForBrowser || isWaitingForChatInput || isFinished) && (
        <div className="px-4 py-3 border-t border-white/5 bg-black/40 backdrop-blur-md shrink-0 z-30">
          {isWaitingForBrowser ? (
            <div className="space-y-3">
              {(session as { waitingMessage?: string }).waitingMessage && (
                <p className="text-xs text-white/70 leading-relaxed">
                  {(session as { waitingMessage?: string }).waitingMessage}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  type="button"
                  className="flex-1"
                  onClick={() => void handleResumeBrowser()}
                  isLoading={resumePending}
                >
                  <Play className="w-4 h-4 mr-2" />
                  Resume
                </Button>
                <Button type="button" variant="glass" onClick={() => setLocation('/')}>
                  Home
                </Button>
              </div>
            </div>
          ) : isWaitingForChatInput ? (
            <form onSubmit={handleSendInput} className="flex gap-2">
              <div className="relative flex-1">
                <MessageSquare className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" />
                <Input
                  autoFocus
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder="Agent needs your input..."
                  className="pl-9 bg-black/80 border-primary/50"
                />
              </div>
              <Button type="submit" isLoading={inputMutation.isPending} className="shrink-0">
                <ChevronRight className="w-4 h-4" />
              </Button>
            </form>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/50 flex items-center gap-2">
                {session.status === 'completed'
                  ? <><CheckCircle2 className="w-4 h-4 text-emerald-500" />Task completed</>
                  : session.status === 'error'
                  ? <><AlertCircle className="w-4 h-4 text-destructive" />Task failed</>
                  : <><Square className="w-4 h-4" />Session stopped</>
                }
              </span>
              <Button variant="glass" size="sm" onClick={() => setLocation('/')}>
                New task
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
