"use client";

import { useState, useEffect, useRef } from "react";

export default function Home() {
  const [meetingUrl, setMeetingUrl] = useState("");
  const [botName, setBotName] = useState("Meeting Oracle");
  const [isBotRunning, setIsBotRunning] = useState(false);
  const [botStatus, setBotStatus] = useState<string>("idle");
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [setupStatus, setSetupStatus] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ time: string; msg: string; type: 'info' | 'verse' | 'note' }[]>([]);
  const [mounted, setMounted] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 100);
    return () => clearTimeout(timer);
  }, []);

  // Poll bot status every 3 seconds while running
  useEffect(() => {
    if (isBotRunning) {
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch('/api/bot');
          const data = await res.json();
          setBotStatus(data.status ?? 'idle');
          if (data.status === 'error' || data.status === 'idle') {
            setIsBotRunning(false);
            clearInterval(pollRef.current!);
          }
        } catch { /* ignore */ }
      }, 3000);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [isBotRunning]);

  const startBot = async () => {
    if (!meetingUrl) return;
    setIsBotRunning(true);
    setBotStatus('launching');
    addLog("Initializing Oracle...", 'info');

    try {
      const res = await fetch('/api/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: meetingUrl, name: botName }),
      });
      const data = await res.json();

      if (!res.ok) {
        addLog(`Error: ${data.error || 'Failed to start bot'}`, 'note');
        setIsBotRunning(false);
      } else {
        addLog(data.message || "Bot is launching — check server console for progress.", 'info');
      }
    } catch (err: unknown) {
      addLog(`Network Error: ${err instanceof Error ? err.message : 'Unknown error'}`, 'note');
      setIsBotRunning(false);
    }
  };

  const stopBot = async () => {
    addLog("Stopping bot...", 'info');
    try {
      await fetch('/api/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
    } catch { /* ignore */ }
    setIsBotRunning(false);
    setBotStatus('idle');
    addLog("Bot stopped.", 'info');
  };

  const setupLogin = async () => {
    setIsSettingUp(true);
    setSetupStatus("Opening bot Chrome profile... Log into Google, then close the browser window.");
    try {
      const res = await fetch('/api/bot/setup', { method: 'POST' });
      const data = await res.json();
      setSetupStatus(data.success ? "✅ Setup complete! You can now start the bot." : `❌ Setup error: ${data.error}`);
    } catch (err: unknown) {
      setSetupStatus(`❌ ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsSettingUp(false);
    }
  };

  const addLog = (msg: string, type: 'info' | 'verse' | 'note' = 'info') => {
    setLogs(prev => [{ time: new Date().toLocaleTimeString(), msg, type }, ...prev]);
  };

  const statusLabel: Record<string, string> = {
    idle: 'Standby',
    launching: 'Launching...',
    joining: 'Joining...',
    'in-meeting': 'In Meeting',
    error: 'Error',
  };

  const statusColor: Record<string, string> = {
    idle: 'bg-[#444]',
    launching: 'bg-yellow-500 animate-pulse',
    joining: 'bg-yellow-400 animate-pulse',
    'in-meeting': 'bg-green-500 animate-pulse',
    error: 'bg-red-500',
  };

  if (!mounted) return null;

  return (
    <main className="min-h-screen bg-black text-[#ededed] selection:bg-white selection:text-black">
      {/* Top Navigation */}
      <nav className="border-b border-white/10 sticky top-0 bg-black/80 backdrop-blur-md z-50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
             <div className="w-5 h-5 rounded-sm bg-white flex items-center justify-center">
                <div className="w-1.5 h-1.5 bg-black rounded-full" />
             </div>
             <span className="font-medium tracking-tight">Meeting Oracle</span>
          </div>
          
          <div className="flex items-center gap-4 text-sm text-[#888]">
            <span className="hidden sm:inline-block">v3.0</span>
            <div className="hidden sm:block w-px h-4 bg-white/10" />
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 px-3 py-1 rounded-full">
              <span className={`w-2 h-2 rounded-full ${statusColor[botStatus] ?? 'bg-[#444]'}`} />
              <span className="text-xs font-medium text-white">{statusLabel[botStatus] ?? botStatus}</span>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-12 md:py-24 grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-20">
        {/* Left Column */}
        <div className="lg:col-span-5 space-y-10">
          <div className="space-y-4">
            <h1 className="text-4xl md:text-5xl font-semibold tracking-tight text-white leading-tight">
              Connect to your meeting.
            </h1>
            <p className="text-[#888] text-base leading-relaxed max-w-md">
              Drop your meeting URL below. The Oracle joins autonomously, records audio, transcribes with Whisper, and sends real-time AI notes via Qwen2.5.
            </p>
          </div>

          <div className="space-y-4">
            {/* Bot Name */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-[#888] uppercase tracking-wider">
                Bot Display Name
              </label>
              <input
                type="text"
                placeholder="Meeting Oracle"
                className="w-full bg-transparent border border-white/10 rounded-lg px-4 py-3 text-sm text-white placeholder:text-[#555] focus:outline-none focus:border-white focus:ring-1 focus:ring-white transition-all disabled:opacity-50"
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
                disabled={isBotRunning}
              />
            </div>

            {/* Meeting URL */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-[#888] uppercase tracking-wider">
                Meeting URL
              </label>
              <input
                type="text"
                placeholder="meet.google.com/xyz-abc-def"
                className="w-full bg-transparent border border-white/10 rounded-lg px-4 py-3 text-sm text-white placeholder:text-[#555] focus:outline-none focus:border-white focus:ring-1 focus:ring-white transition-all disabled:opacity-50"
                value={meetingUrl}
                onChange={(e) => setMeetingUrl(e.target.value)}
                disabled={isBotRunning}
              />
            </div>

            {/* Setup Button */}
            <button
              onClick={setupLogin}
              disabled={isSettingUp || isBotRunning}
              className="w-full bg-transparent border border-white/20 text-white hover:border-white/40 font-medium rounded-lg h-10 text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-40"
            >
              {isSettingUp ? (
                <>
                  <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Setting up... (log in and close Chrome)
                </>
              ) : '⚙️  Setup Bot Google Login (first time only)'}
            </button>

            {setupStatus && (
              <p className="text-xs text-[#aaa] bg-white/5 border border-white/10 rounded-lg px-3 py-2 leading-relaxed">{setupStatus}</p>
            )}

            {/* Start / Stop */}
            {!isBotRunning ? (
              <button
                onClick={startBot}
                disabled={!meetingUrl}
                className="w-full bg-white text-black hover:bg-[#e0e0e0] font-medium rounded-lg h-11 text-sm flex items-center justify-center gap-2 transition-colors disabled:bg-[#111] disabled:text-[#555] disabled:border disabled:border-white/10"
              >
                Start Recording
              </button>
            ) : (
              <button
                onClick={stopBot}
                className="w-full bg-red-600/80 hover:bg-red-600 text-white font-medium rounded-lg h-11 text-sm flex items-center justify-center gap-2 transition-colors"
              >
                <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                {statusLabel[botStatus] ?? 'Running'} — Stop Bot
              </button>
            )}
          </div>

          <div className="pt-6 border-t border-white/10 space-y-4">
            <h3 className="text-xs font-semibold text-[#888] uppercase tracking-wider">AI Engine</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-[#0a0a0a] border border-white/10 rounded-lg p-4">
                <p className="text-xs text-[#666] mb-1 font-mono">Transcription</p>
                <p className="text-sm font-medium text-[#ededed]">Whisper tiny.en</p>
              </div>
              <div className="bg-[#0a0a0a] border border-white/10 rounded-lg p-4">
                <p className="text-xs text-[#666] mb-1 font-mono">LLM (local)</p>
                <p className="text-sm font-medium text-[#ededed]">Qwen 2.5:3b</p>
              </div>
            </div>
            <div className="bg-[#0a0a0a] border border-white/10 rounded-lg p-4 text-xs text-[#666] leading-relaxed">
              Audio → Whisper (every 5s) → transcription → Bible verse detection + Qwen analysis → chat message
            </div>
          </div>
        </div>

        {/* Right Column: Event Stream */}
        <div className="lg:col-span-7">
          <div className="bg-[#0a0a0a] border border-white/10 rounded-xl flex flex-col h-[600px] lg:h-full min-h-[600px] shadow-2xl overflow-hidden">
            <div className="border-b border-white/10 px-6 py-4 flex items-center justify-between bg-black/40">
              <div className="flex items-center gap-3">
                 <h2 className="text-sm font-medium text-white">Event Stream</h2>
                 {isBotRunning && (
                    <span className="flex h-2 w-2 relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                    </span>
                 )}
              </div>
              <div className="flex items-center gap-3">
                {logs.length > 0 && (
                  <button onClick={() => setLogs([])} className="text-xs text-[#555] hover:text-[#888] transition-colors">
                    Clear
                  </button>
                )}
                <span className="text-xs text-[#666] font-mono bg-white/5 px-2 py-1 rounded">
                  [{logs.length} LOGS]
                </span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {logs.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-[#555] space-y-4">
                  <div className="w-12 h-12 rounded-full border border-white/10 flex items-center justify-center bg-black/50">
                     <svg className="w-5 h-5 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                       <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h7" />
                     </svg>
                  </div>
                  <p className="text-sm font-medium">Awaiting stream initialization...</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {logs.map((log, i) => (
                    <div key={i} className="group px-4 py-3 -mx-4 hover:bg-white/[0.03] rounded-lg transition-colors flex gap-4">
                       <div className="w-16 flex-shrink-0 pt-0.5">
                         <span className="text-xs font-mono text-[#555]">{log.time.split(' ')[0]}</span>
                       </div>
                       <div className="flex-1 space-y-1.5">
                         <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${
                           log.type === 'verse' ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' :
                           log.type === 'note' ? 'bg-white/10 text-white border border-white/10' :
                           'bg-transparent text-[#666] border border-white/10'
                         }`}>
                           {log.type}
                         </span>
                         <p className={`text-sm leading-relaxed ${log.type === 'verse' ? 'text-[#eee]' : 'text-[#aaa]'}`}>
                           {log.msg}
                         </p>
                       </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
