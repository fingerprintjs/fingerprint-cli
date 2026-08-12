import { color } from '../utils/color.js'
import { isCi } from '../utils/ci.js'

// Loading UI for the long agent pass. In default (non-verbose) mode the per-step tool calls are
// hidden, so a few minutes of work can read as "stuck". This keeps one live line: a loader, the
// current high-level activity, and a rotating Fingerprint tip. Verbose mode streams real tool lines
// instead and never uses this.

const TIPS = [
  'Fingerprint re-identifies returning visitors even after they clear cookies or go incognito.',
  'Smart Signals flag bots, VPNs, tampering, and incognito — all verified server-side.',
  'A visitor ID stays stable for months, so repeat fraud is visible across sessions.',
  'Always verify the event server-side: a browser can be spoofed, the Server API cannot.',
  'The public key is safe in the browser; the secret key stays server-side only.',
]

const TIP_MS = 5000
const FRAME_MS = 80

const LOADER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null
  private tipTimer: ReturnType<typeof setInterval> | null = null
  private frame = 0
  private tip = 0
  private message = ''
  private painted = false
  // Redrawing in place (`\r`, `\x1b[K`) only means anything on a live TTY: piped, redirected, or CI
  // output takes those escapes literally. Callers are expected to skip the spinner there and log
  // plain lines instead (see runner.consume); this guard keeps a caller that forgets from corrupting
  // the stream. `print()` still appends its line, so the agent's narration survives either way.
  private readonly live = Boolean(process.stdout.isTTY) && !isCi()

  start(message: string): void {
    if (this.timer || this.tipTimer) return
    this.message = message
    this.frame = 0
    if (!this.live) return
    this.paint()
    this.timer = setInterval(() => {
      this.frame++
      this.paint()
    }, FRAME_MS)
    this.timer.unref?.() // never keep the process alive for the spinner
    this.tipTimer = setInterval(() => {
      this.tip = (this.tip + 1) % TIPS.length
      this.paint()
    }, TIP_MS)
    this.tipTimer.unref?.()
  }

  setMessage(message: string): void {
    this.message = message
    if (this.painted) this.paint()
  }

  // Print a line above the live line without leaving artifacts.
  print(line: string): void {
    this.clear()
    process.stdout.write(line + '\n')
    this.paint()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.tipTimer) {
      clearInterval(this.tipTimer)
      this.tipTimer = null
    }
    this.clear()
  }

  private clear(): void {
    if (!this.painted) return
    process.stdout.write('\r\x1b[K')
    this.painted = false
  }

  private paint(): void {
    if (!this.live) return
    // No trailing newline: the cursor stays on this line so the next paint overwrites it.
    process.stdout.write(`\r\x1b[K${this.statusLine()}`)
    this.painted = true
  }

  private statusLine(): string {
    const glyph = LOADER_FRAMES[this.frame % LOADER_FRAMES.length]
    const head = `${glyph} ${this.message}`
    const cols = process.stdout.columns || 80
    const room = cols - head.length - 2
    let line = `${color.brand(glyph)} ${this.message}`
    if (room > 12) {
      const raw = `  ${TIPS[this.tip]}`
      const tip = raw.length > room ? raw.slice(0, room - 1) + '…' : raw
      line += color.dim(tip)
    }
    return line
  }
}

// Map a tool name to the high-level activity shown on the spinner — coarse on purpose, so the user
// sees "what stage" not "which file".
export function activityFor(tool: string): string | undefined {
  switch (tool) {
    case 'Read':
    case 'Glob':
    case 'Grep':
      return 'Exploring your codebase'
    case 'Edit':
    case 'Write':
      return 'Applying changes'
    case 'WebFetch':
    case 'WebSearch':
      return 'Reading Fingerprint docs'
    case 'Skill':
      return 'Reading the integration guide'
    case 'Agent':
      return 'Analyzing the integration'
    default:
      return undefined
  }
}
