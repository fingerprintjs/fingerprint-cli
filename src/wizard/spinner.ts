import { color } from '../utils/color.js'
import { isCi } from '../utils/ci.js'
import { colorizeFrame, frameDurationMs, frameLines } from './asciiPlayer.js'
import { INTEGRATE_ANIMATION } from './animations/integrate.js'

// Loading UI for the long agent pass. In default (non-verbose) mode the per-step tool calls are
// hidden, so a few minutes of work can read as "stuck". This keeps a live ASCII Motion–style
// animation (https://ascii-motion.app) plus a status line with the current high-level activity and
// a rotating Fingerprint tip. Verbose mode streams real tool lines instead and never uses this.

const TIPS = [
  'Fingerprint re-identifies returning visitors even after they clear cookies or go incognito.',
  'Smart Signals flag bots, VPNs, tampering, and incognito — all verified server-side.',
  'A visitor ID stays stable for months, so repeat fraud is visible across sessions.',
  'Always verify the event server-side: a browser can be spoofed, the Server API cannot.',
  'The public key is safe in the browser; the secret key stays server-side only.',
]

const TIP_MS = 5000

export class Spinner {
  private timer: ReturnType<typeof setTimeout> | null = null
  private tipTimer: ReturnType<typeof setInterval> | null = null
  private frame = 0
  private tip = 0
  private message = ''
  private height = 0 // animation lines + 1 status line, once painted
  // The redraw addresses the cursor (`\x1b[nA`, `\x1b[2K`), which only means anything on a live TTY:
  // piped, redirected, or CI output takes those escapes literally and fills with garbage. Callers are
  // expected to skip the spinner there and log plain lines instead (see runner.consume); this guard
  // keeps a caller that forgets from corrupting the stream. `print()` still appends its line, so the
  // agent's narration survives either way.
  private readonly live = Boolean(process.stdout.isTTY) && !isCi()

  start(message: string): void {
    if (this.timer || this.tipTimer) return
    this.message = message
    this.frame = 0
    if (!this.live) return
    this.paint(true)
    this.scheduleFrame()
    this.tipTimer = setInterval(() => {
      this.tip = (this.tip + 1) % TIPS.length
      this.paint(false)
    }, TIP_MS)
    this.tipTimer.unref?.()
  }

  setMessage(message: string): void {
    this.message = message
    if (this.height) this.paint(false)
  }

  // Print a line above the live block without leaving artifacts.
  print(line: string): void {
    this.clear()
    process.stdout.write(line + '\n')
    this.paint(true)
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.tipTimer) {
      clearInterval(this.tipTimer)
      this.tipTimer = null
    }
    this.clear()
  }

  private scheduleFrame(): void {
    const ms = frameDurationMs(INTEGRATE_ANIMATION, this.frame)
    this.timer = setTimeout(() => {
      this.frame++
      this.paint(false)
      this.scheduleFrame()
    }, ms)
    this.timer.unref?.()
  }

  private clear(): void {
    if (!this.height) return
    // Cursor is on the status (last) line — move to the top of the block and erase downward.
    process.stdout.write(`\x1b[${this.height - 1}A\r`)
    for (let i = 0; i < this.height; i++) {
      process.stdout.write('\x1b[2K')
      if (i < this.height - 1) process.stdout.write('\n')
    }
    process.stdout.write(`\x1b[${this.height - 1}A\r`)
    this.height = 0
  }

  private paint(first: boolean): void {
    if (!this.live) return
    const anim = colorizeFrame(frameLines(INTEGRATE_ANIMATION, this.frame))
    const status = this.statusLine()
    const block = [...anim, status]

    if (!first && this.height > 0) {
      process.stdout.write(`\x1b[${this.height - 1}A\r`)
    }

    for (let i = 0; i < block.length; i++) {
      process.stdout.write(`\x1b[2K${block[i]}`)
      if (i < block.length - 1) process.stdout.write('\n')
    }
    this.height = block.length
  }

  private statusLine(): string {
    const head = `◇ ${this.message}`
    const cols = process.stdout.columns || 80
    const room = cols - head.length - 2
    let line = `${color.cyan('◇')} ${this.message}`
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
