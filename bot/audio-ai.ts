// bot/audio-ai.ts
// Handles: audio buffer → FFmpeg (resample) → Whisper (transcribe) → Qwen (analyze) → callback
import fetch from 'node-fetch';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';

let ffmpegPath = 'ffmpeg';
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
} catch {
  // fall back to system ffmpeg
}

export class AudioAIProcessor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private transcriber: any = null;
  private initialized = false;
  private processing = false;

  // Regex to match Bible references like "John 3:16" or "1 Corinthians 13:4-7"
  private bibleRegex = /((?:[123]\s)?[A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s(\d+):(\d+)(?:-(\d+))?/g;

  constructor(
    private onVerseIdentified: (verse: string, text: string) => void,
    private onGeneralNote: (note: string) => void
  ) {}

  async init() {
    if (this.initialized) return;
    console.log('[AI] Loading Whisper tiny.en model...');
    try {
      const { pipeline: getPipeline } = await import('@xenova/transformers');
      this.transcriber = await getPipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
      this.initialized = true;
      console.log('[AI] ✅ Whisper model ready.');
    } catch (err) {
      console.error('[AI] ❌ Whisper load failed:', err);
      // Continue without whisper — AI features won't work but bot still joins
    }
  }

  /**
   * Main entry point: receives a raw audio buffer (webm/opus from Meet),
   * resamples it to 16kHz mono PCM via FFmpeg, then transcribes with Whisper.
   */
  async processAudioBuffer(buffer: Buffer) {
    if (!this.initialized || !this.transcriber || this.processing) return;
    if (buffer.length < 1000) return; // Skip tiny/empty chunks

    this.processing = true;
    try {
      const float32 = await this.decodeAudioBuffer(buffer);
      if (!float32 || float32.length === 0) return;

      const result = await this.transcriber(float32);
      const text = result?.text?.trim();

      if (text && text.length > 5 && text !== '[BLANK_AUDIO]') {
        console.log(`[Whisper] "${text}"`);
        await this.processTranscript(text);
      }
    } catch (err) {
      console.error('[AI] processAudioBuffer error:', err);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Decodes a webm/opus buffer to Float32Array at 16kHz mono
   * using FFmpeg spawned as a child process.
   */
  private async decodeAudioBuffer(input: Buffer): Promise<Float32Array | null> {
    return new Promise((resolve) => {
      // Pipe input buffer → ffmpeg → raw 16kHz mono s16le PCM → collect → convert to Float32
      const ffmpeg = spawn(ffmpegPath, [
        '-f', 'webm',     // input format
        '-i', 'pipe:0',   // read from stdin
        '-ar', '16000',   // resample to 16kHz
        '-ac', '1',       // mono
        '-f', 's16le',    // raw signed 16-bit little-endian PCM
        'pipe:1',         // output to stdout
      ], { stdio: ['pipe', 'pipe', 'ignore'] });

      const chunks: Buffer[] = [];

      ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

      ffmpeg.on('close', () => {
        const pcm = Buffer.concat(chunks);
        if (pcm.length < 2) { resolve(null); return; }

        // Convert 16-bit PCM to Float32 (range -1.0 to 1.0)
        const float32 = new Float32Array(pcm.length / 2);
        for (let i = 0; i < float32.length; i++) {
          float32[i] = pcm.readInt16LE(i * 2) / 32768.0;
        }
        resolve(float32);
      });

      ffmpeg.on('error', (err: Error) => {
        console.error('[AI] FFmpeg error:', err.message);
        resolve(null);
      });

      // Write the webm buffer to ffmpeg's stdin
      const inStream = new PassThrough();
      inStream.pipe(ffmpeg.stdin);
      inStream.end(input);
    });
  }

  async processTranscript(text: string) {
    if (!text || text.length < 5) return;

    // 1. Check for Bible verse references
    let hadVerse = false;
    this.bibleRegex.lastIndex = 0;
    let match;
    while ((match = this.bibleRegex.exec(text)) !== null) {
      const reference = match[0];
      await this.fetchAndSendVerse(reference);
      hadVerse = true;
    }

    // 2. Send to Qwen2.5:3b via Ollama for general meeting notes
    // (only if Ollama is reachable — non-fatal if it's not)
    await this.queryOllama(text, hadVerse);
  }

  private async fetchAndSendVerse(ref: string) {
    try {
      const res = await fetch(`https://bible-api.com/${encodeURIComponent(ref)}`);
      const data = await res.json() as { text?: string };
      if (data.text) {
        const verseText = data.text.trim().replace(/\n/g, ' ');
        console.log(`[AI] 📖 Verse found: ${ref}`);
        this.onVerseIdentified(ref, verseText);
      }
    } catch (err) {
      console.error('[AI] Bible API error:', err);
    }
  }

  private async queryOllama(text: string, hadVerse: boolean) {
    try {
      const prompt = hadVerse
        ? `A Bible verse was mentioned. The speaker said: "${text}". Provide a brief 1-sentence context note about this passage. If nothing meaningful to add, respond with NONE.`
        : `You are a meeting assistant. The speaker said: "${text}". If they mention any specific fact, reference, person, or topic worth noting, give a brief 1-sentence insight. Otherwise respond with NONE.`;

      const response = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5:3b',
          prompt,
          stream: false,
        }),
        // 8-second timeout so it doesn't block too long
        signal: AbortSignal.timeout(8000),
      });

      const data = await response.json() as { response?: string };
      const answer = data.response?.trim();
      if (answer && answer !== 'NONE' && answer.length > 5) {
        console.log(`[Qwen] Note: ${answer}`);
        this.onGeneralNote(answer);
      }
    } catch {
      // Ollama not running or timed out — silent fail, not critical
    }
  }
}
