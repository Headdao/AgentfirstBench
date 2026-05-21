/**
 * Tiny braille spinner with no external deps. Renders to stderr so it
 * doesn't pollute stdout (which the user may want to pipe).
 *
 * When stderr is not a TTY (CI, redirected), `start()` becomes a no-op
 * and `update()` prints periodic plain-text status lines instead, so the
 * log stays readable.
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 80;
const TTY_STATUS_REWRITE = '\r\x1b[K';

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private currentMessage = '';
  private isTTY: boolean;
  private lastNonTTYLog = 0;

  constructor(private readonly stream: NodeJS.WriteStream = process.stderr) {
    this.isTTY = !!stream.isTTY;
  }

  start(message: string): void {
    this.currentMessage = message;
    if (!this.isTTY) {
      this.stream.write(`${message}\n`);
      return;
    }
    this.render();
    this.timer = setInterval(() => this.render(), FRAME_INTERVAL_MS);
  }

  update(message: string): void {
    this.currentMessage = message;
    if (!this.isTTY) {
      // Throttle plain-text updates so non-TTY logs don't get flooded.
      const now = Date.now();
      if (now - this.lastNonTTYLog > 1000) {
        this.stream.write(`${message}\n`);
        this.lastNonTTYLog = now;
      }
      return;
    }
    this.render();
  }

  stop(finalMessage?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.isTTY) {
      this.stream.write(TTY_STATUS_REWRITE);
    }
    if (finalMessage) {
      this.stream.write(`${finalMessage}\n`);
    }
  }

  private render(): void {
    if (!this.isTTY) return;
    const f = FRAMES[this.frame % FRAMES.length];
    this.stream.write(`${TTY_STATUS_REWRITE}${f} ${this.currentMessage}`);
    this.frame++;
  }
}
