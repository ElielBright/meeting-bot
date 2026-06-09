// src/app/api/bot/setup/route.ts
// One-time setup: opens the bot's dedicated Chrome profile so you can log in to Google.
// Uses child_process.spawn (NOT Puppeteer) so Google doesn't detect automation.
// After logging in to Google, close the Chrome window — session is saved in bot-chrome-profile/
import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const BOT_PROFILE_DIR = path.join(process.cwd(), 'bot-chrome-profile');

const SYSTEM_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
];

function findSystemChrome(): string | null {
  for (const p of SYSTEM_CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function POST() {
  try {
    if (!fs.existsSync(BOT_PROFILE_DIR)) {
      fs.mkdirSync(BOT_PROFILE_DIR, { recursive: true });
    }

    const chromePath = findSystemChrome();
    if (!chromePath) {
      return NextResponse.json({ error: 'System Chrome not found. Please install Google Chrome.' }, { status: 500 });
    }

    console.log(`[Setup] Opening bot Chrome profile (no automation) at: ${BOT_PROFILE_DIR}`);
    console.log(`[Setup] Using Chrome: ${chromePath}`);

    // Launch Chrome directly via child_process — NO Puppeteer, NO DevTools protocol.
    // This is critical: Google detects Puppeteer's DevTools flags and blocks sign-in.
    // A plain child_process.spawn launch is indistinguishable from a normal user opening Chrome.
    const chromeProcess = spawn(chromePath, [
      `--user-data-dir=${BOT_PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      'https://accounts.google.com',
    ], {
      detached: false,
      stdio: 'ignore',
    });

    console.log('[Setup] Chrome opened with PID:', chromeProcess.pid);
    console.log('[Setup] Sign into Google, then close the Chrome window. Session will be saved.');

    // Wait for Chrome to close
    await new Promise<void>((resolve, reject) => {
      chromeProcess.on('close', (code) => {
        console.log(`[Setup] Chrome closed (exit code: ${code}). Session saved to bot-chrome-profile/`);
        resolve();
      });
      chromeProcess.on('error', reject);
    });

    return NextResponse.json({
      success: true,
      message: 'Setup complete! Bot Google session saved. You can now start the bot.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Setup] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
