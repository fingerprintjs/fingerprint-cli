import chalk from 'chalk'

// A dependency-free single-line spinner for the long agent pass. In default (non-verbose) mode the
// per-step tool calls are hidden, so a few minutes of work can read as "stuck". This keeps a live
// line showing the current high-level activity plus a rotating Fingerprint tip, so a quiet stretch
// reads as "still working, on track" rather than frozen. Verbose mode streams real tool lines
// instead and never uses this.

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// Shown as a dim, ephemeral suffix that cycles every few seconds — gives the user something to read
// and makes elapsed time visible. Purely cosmetic; nothing here is load-bearing.
const TIPS = [
  'Fingerprint re-identifies returning visitors even after they clear cookies or go incognito.',
  'Smart Signals flag bots, VPNs, tampering, and incognito — all verified server-side.',
  'A visitor ID stays stable for months, so repeat fraud is visible across sessions.',
  'Always verify the event server-side: a browser can be spoofed, the Server API cannot.',
  'The public key is safe in the browser; the secret key stays server-side only.',
]

const FRAME_MS = 80
const TIP_EVERY = Math.round(5000 / FRAME_MS) // rotate the tip ~every 5s

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null
  private frame = 0
  private ticks = 0
  private tip = 0
  private message = ''

  start(message: string): void {
    if (this.timer) return
    this.message = message
    this.render()
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length
      this.ticks++
      if (this.ticks % TIP_EVERY === 0) this.tip = (this.tip + 1) % TIPS.length
      this.render()
    }, FRAME_MS)
    this.timer.unref?.() // never keep the process alive for the spinner
  }

  setMessage(message: string): void {
    this.message = message
    if (this.timer) this.render()
  }

  // Print a line above the spinner without leaving artifacts on the live line.
  print(line: string): void {
    this.clear()
    process.stdout.write(line + '\n')
    if (this.timer) this.render()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.clear()
  }

  private clear(): void {
    process.stdout.write('\r\x1b[K')
  }

  private render(): void {
    // Measure with plain strings (color codes would break the width math), then colorize. The tip
    // is truncated to the remaining columns so the line never wraps and breaks the \r redraw.
    const head = `${FRAMES[this.frame]} ${this.message}`
    const cols = process.stdout.columns || 80
    const room = cols - head.length - 2
    let line = `${chalk.cyan(FRAMES[this.frame])} ${this.message}`
    if (room > 12) {
      const raw = `  ${TIPS[this.tip]}`
      const tip = raw.length > room ? raw.slice(0, room - 1) + '…' : raw
      line += chalk.dim(tip)
    }
    process.stdout.write(`\r\x1b[K${line}`)
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
