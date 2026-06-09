// bot/core.ts
import puppeteer, { Page, Browser } from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { AudioAIProcessor } from './audio-ai';

interface BotOptions {
  url: string;
  name: string;
  headless?: boolean;
  onAudioData?: (chunk: Buffer) => void;
  onLog?: (msg: string, type: 'info' | 'verse' | 'note') => void;
}

// Persistent bot profile — stores Google login session between restarts
const BOT_PROFILE_DIR = path.join(process.cwd(), 'bot-chrome-profile');

export class MeetingBot {
  private page: Page | null = null;
  private browser: Browser | null = null;
  private ai: AudioAIProcessor | null = null;
  public status: 'idle' | 'launching' | 'joining' | 'in-meeting' | 'error' = 'idle';

  constructor(public options: BotOptions) {}

  public setAudioHandler(handler: (chunk: Buffer) => void) {
    this.options.onAudioData = handler;
  }

  public setAI(processor: AudioAIProcessor) {
    this.ai = processor;
  }

  private log(msg: string, type: 'info' | 'verse' | 'note' = 'info') {
    if (this.options.onLog) this.options.onLog(msg, type);
    console.log(`[Bot ${type.toUpperCase()}] ${msg}`);
  }

  async launch() {
    this.status = 'launching';
    this.log(`Launching bot for ${this.options.url}...`);

    if (!fs.existsSync(BOT_PROFILE_DIR)) {
      fs.mkdirSync(BOT_PROFILE_DIR, { recursive: true });
    }

    // IMPORTANT: Use Puppeteer's bundled Chromium (NOT system Chrome).
    // puppeteer-stream's extension requires CDP Extensions.loadUnpacked,
    // which only works with Puppeteer's own Chromium build.
    const chromiumPath = puppeteer.executablePath();
    this.log(`Using Chromium: ${chromiumPath}`);

    this.log(`Using Chromium: ${chromiumPath}`);

    try {
      this.browser = (await puppeteer.launch({
        executablePath: chromiumPath,
        userDataDir: BOT_PROFILE_DIR,
        defaultViewport: null,
        headless: false,
        args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=BackForwardCache',
          '--autoplay-policy=no-user-gesture-required',
          '--window-size=1280,720',
        ],
      })) as unknown as Browser;

      this.browser.on('disconnected', () => {
        this.log('Browser disconnected.');
        this.status = 'error';
      });

      const pages = await this.browser.pages();
      this.page = pages[0] || await this.browser.newPage();

      this.page.on('error', (err) => this.log(`Page error: ${err.message}`));
      this.page.on('close', () => {
        this.log('Page closed.');
        this.status = 'error';
      });

      // Grant permissions upfront for meet.google.com
      const context = this.browser.defaultBrowserContext();
      await context.overridePermissions('https://meet.google.com', [
        'camera', 'microphone', 'notifications',
      ]);

      this.status = 'joining';

      await this.page.goto(this.options.url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      this.log('Navigated to meeting URL.');

      // Check for redirect to sign-in (bot not logged in)
      await new Promise(r => setTimeout(r, 2000));
      if (this.page.url().includes('accounts.google.com')) {
        this.log('⚠️ Bot is not signed in! Run Setup first.', 'note');
        this.status = 'error';
        return;
      }

      // Wait for Meet UI to fully render
      await new Promise(r => setTimeout(r, 3000));

      // --- Step 1: Set display name in pre-join lobby ---
      await this.setDisplayName();

      // --- Step 2: Mute mic + camera before joining ---
      await this.muteBeforeJoin();

      // --- Step 3: Wait a moment then click join ---
      await new Promise(r => setTimeout(r, 1000));
      const joined = await this.clickJoinButton();

      if (!joined) {
        this.log('Could not find join button. Bot may already be in meeting or lobby is not shown.', 'note');
      } else {
        this.log('Join clicked. Waiting for meeting to load...');
      }

      // Allow time for the meeting call to establish
      await new Promise(r => setTimeout(r, 6000));
      this.status = 'in-meeting';
      this.log('Bot is in-meeting. Starting audio capture...');

      // --- Step 4: Start audio stream + pipe to AI ---
      await this.startAudioCapture();

    } catch (err: unknown) {
      this.status = 'error';
      this.log(`Launch error: ${err instanceof Error ? err.message : String(err)}`);
      if (this.browser) await this.browser.close().catch(() => {});
    }
  }

  private async setDisplayName() {
    if (!this.page) return;
    try {
      // Google Meet pre-join lobby has an editable name field
      // Selector targets the input that appears when you hover over your name
      const selectors = [
        'input[aria-label="Your name"]',
        'input[placeholder="Your name"]',
        '[data-self-name] input',
        'input[jsname="YPqjbf"]',
      ];

      let nameInput = null;
      for (const sel of selectors) {
        try {
          nameInput = await this.page.waitForSelector(sel, { timeout: 3000, visible: true });
          if (nameInput) break;
        } catch { /* try next */ }
      }

      if (nameInput) {
        await nameInput.click({ clickCount: 3 });
        await nameInput.type(this.options.name);
        this.log(`Set display name to: ${this.options.name}`);
      } else {
        this.log('No name input found — bot will appear as signed-in Google account name.', 'note');
      }
    } catch {
      this.log('Could not set display name (non-fatal).', 'note');
    }
  }

  private async muteBeforeJoin() {
    if (!this.page) return;
    try {
      // Attempt to mute mic and camera using aria-label patterns
      const muteSelectors = [
        '[aria-label*="microphone" i]',
        '[aria-label*="camera" i]',
        '[data-is-muted="false"][aria-label*="Turn off"]',
      ];
      for (const sel of muteSelectors) {
        const btn = await this.page.$(sel);
        if (btn) await btn.click().catch(() => {});
      }
    } catch { /* non-fatal */ }
  }

  private async clickJoinButton(): Promise<boolean> {
    if (!this.page) return false;

    // Strategy 1: Google Meet's actual join button jsnames (2024-2025)
    const joinJsnames = [
      'Qx7uuf',  // "Join now" 
      'V8H9t',   // "Ask to join"
      'j7pSHb',  // Alternative join
    ];
    for (const jsname of joinJsnames) {
      try {
        const btn = await this.page.$(`[jsname="${jsname}"]`);
        if (btn) {
          const text = await this.page.evaluate(el => el.textContent || '', btn);
          this.log(`Clicking join button (jsname=${jsname}): "${text.trim()}"`);
          await btn.click();
          return true;
        }
      } catch { /* try next */ }
    }

    // Strategy 2: data-idom-class containing join-related class
    try {
      const btn = await this.page.$('[data-idom-class*="join" i], [data-idom-class*="Join" i]');
      if (btn) {
        this.log('Clicking join button (data-idom-class).');
        await btn.click();
        return true;
      }
    } catch { /* try next */ }

    // Strategy 3: Scan all buttons for join text (case insensitive)
    try {
      const joined = await this.page.evaluate(() => {
        const keywords = ['join now', 'ask to join', 'join meeting', 'join call'];
        const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const btn of allBtns) {
          const text = (btn.textContent || '').toLowerCase().trim();
          if (keywords.some(k => text.includes(k))) {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (joined) {
        this.log('Clicked join button (text scan).');
        return true;
      }
    } catch { /* try next */ }

    // Strategy 4: wait up to 10s for a join button to appear, then retry
    try {
      await this.page.waitForFunction(() => {
        const keywords = ['join now', 'ask to join', 'join meeting'];
        const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
        return allBtns.some(btn =>
          keywords.some(k => (btn.textContent || '').toLowerCase().includes(k))
        );
      }, { timeout: 10000 });

      const joined = await this.page.evaluate(() => {
        const keywords = ['join now', 'ask to join', 'join meeting'];
        const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const btn of allBtns) {
          const text = (btn.textContent || '').toLowerCase();
          if (keywords.some(k => text.includes(k))) {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (joined) {
        this.log('Clicked join button (delayed scan).');
        return true;
      }
    } catch { /* timed out */ }

    return false;
  }

  private async startAudioCapture() {
    if (!this.page) return;

    try {
      const recordingPath = path.join(process.cwd(), `recording_${Date.now()}.webm`);
      const fileStream = fs.createWriteStream(recordingPath);
      const chunks: Buffer[] = [];
      const CHUNK_DURATION_MS = 5000;

      // Expose a function that the page can call to send audio chunks back to Node
      await this.page.exposeFunction('onAudioChunk', (base64Chunk: string) => {
        const buffer = Buffer.from(base64Chunk, 'base64');
        fileStream.write(buffer);
        
        if (this.options.onAudioData) {
          this.options.onAudioData(buffer);
        }
        chunks.push(buffer);
      });

      // Inject audio capture script into the page
      await this.page.evaluate(async () => {
        try {
          // Capture the system audio output (what the user hears in the meeting)
          // Since we passed --auto-select-desktop-capture-source and --use-fake-ui-for-media-stream,
          // getDisplayMedia should auto-resolve without a prompt.
          // However, a simpler way is to capture the audio of the <audio> elements on the page directly,
          // but Google Meet uses complex WebRTC.
          
          // The most reliable way for headless Meet is capturing the whole tab audio
          // using navigator.mediaDevices.getDisplayMedia
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true, // video is usually required to capture tab audio
            audio: true
          });

          // We only care about the audio track
          const audioTrack = stream.getAudioTracks()[0];
          if (!audioTrack) {
            console.error('No audio track found in display media');
            return;
          }

          const audioStream = new MediaStream([audioTrack]);
          const mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });

          mediaRecorder.ondataavailable = async (e) => {
            if (e.data.size > 0) {
              const buffer = await e.data.arrayBuffer();
              // Convert to base64 to send across puppeteer boundary
              const base64 = btoa(
                new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
              );
              // @ts-expect-error injected function
              window.onAudioChunk(base64);
            }
          };

          // Record in 1-second chunks
          mediaRecorder.start(1000);
          console.log('Audio capture started');
          
        } catch (err) {
          console.error('Failed to start audio capture:', err);
        }
      });

      // Process chunks for AI every 5 seconds
      const aiInterval = setInterval(async () => {
        if (chunks.length === 0 || !this.ai) return;
        const combined = Buffer.concat(chunks.splice(0, chunks.length));
        try {
          await this.ai.processAudioBuffer(combined);
        } catch (e) {
          this.log(`AI processing error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }, CHUNK_DURATION_MS);

      this.log(`✅ Recording started: ${recordingPath}`);

      // Clean up on close
      this.page.on('close', () => {
        clearInterval(aiInterval);
        fileStream.close();
      });

    } catch (streamErr: unknown) {
      this.log(`Audio stream failed: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`);
    }
  }

  async sendChatMessage(msg: string) {
    if (!this.page) return;
    try {
      // Open chat panel
      const chatSelectors = [
        '[aria-label*="Chat with everyone" i]',
        '[jsname*="chat" i]',
        '[data-tooltip*="chat" i]',
      ];
      for (const sel of chatSelectors) {
        const btn = await this.page.$(sel);
        if (btn) { await btn.click(); break; }
      }

      // Wait for chat input
      const inputSelectors = [
        'textarea[aria-label*="Send a message" i]',
        'textarea[aria-label*="message" i]',
        '[contenteditable="true"][aria-label*="message" i]',
        '[jsname="r4nke"]',
      ];
      let input = null;
      for (const sel of inputSelectors) {
        try {
          input = await this.page.waitForSelector(sel, { timeout: 3000, visible: true });
          if (input) break;
        } catch { /* try next */ }
      }

      if (!input) {
        this.log('Chat input not found.', 'note');
        return;
      }

      await input.click();
      await this.page.keyboard.type(msg);
      await this.page.keyboard.press('Enter');
      this.log(`Chat sent: ${msg.substring(0, 50)}...`);
    } catch (err: unknown) {
      this.log(`Chat send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async stop() {
    this.log('Stopping bot...');
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    this.page = null;
    this.status = 'idle';
  }
}
