// src/app/api/bot/route.ts
import { NextResponse } from 'next/server';
import { MeetingBot } from '@/../bot/core';
import { AudioAIProcessor } from '@/../bot/audio-ai';

let activeBot: MeetingBot | null = null;

export async function POST(req: Request) {
  const { url, name, action } = await req.json();

  // ── Stop ─────────────────────────────────────────
  if (action === 'stop') {
    if (activeBot) {
      await activeBot.stop();
      activeBot = null;
    }
    return NextResponse.json({ success: true, message: 'Bot stopped.' });
  }

  // ── Launch ────────────────────────────────────────
  if (!url) return NextResponse.json({ error: 'URL required' }, { status: 400 });

  if (activeBot && (activeBot.status === 'launching' || activeBot.status === 'joining' || activeBot.status === 'in-meeting')) {
    return NextResponse.json({
      success: false,
      message: `Bot already running (status: ${activeBot.status}). Stop it first.`,
    });
  }

  const botName = name?.trim() || 'Meeting Oracle';

  const bot = new MeetingBot({
    url,
    name: botName,
    headless: false,
    onLog: (msg, type) => console.log(`[LOG ${type}] ${msg}`),
  });

  const ai = new AudioAIProcessor(
    (ref, text) => {
      const msg = `📖 ${ref}: "${text}"`;
      console.log(`[VERSE] ${msg}`);
      bot.sendChatMessage(msg);
    },
    (note) => {
      const msg = `🤖 AI Note: ${note}`;
      console.log(`[NOTE] ${msg}`);
      bot.sendChatMessage(msg);
    }
  );

  // Give the bot a reference to the AI processor
  bot.setAI(ai);

  activeBot = bot;

  // Fire-and-forget: init Whisper then launch bot (don't await in the handler)
  ai.init()
    .then(() => bot.launch())
    .catch((err) => console.error('[Bot background error]', err));

  return NextResponse.json({
    success: true,
    message: `Bot "${botName}" is launching. Watch the server console for progress.`,
  });
}

export async function GET() {
  return NextResponse.json({
    active: activeBot !== null,
    status: activeBot?.status ?? 'idle',
  });
}
