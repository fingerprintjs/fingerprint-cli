import { color } from '../utils/color.js'
import { isCi } from '../utils/ci.js'

// Loading UI for the long agent pass. In default (non-verbose) mode the per-step tool calls are
// hidden, so a few minutes of work can read as "stuck". This keeps one live line: a loader and the
// current high-level activity. Verbose mode streams real tool lines instead and never uses this.

const FRAME_MS = 80

const LOADER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null
  private frame = 0
  private message = ''
  private painted = false
  // Redrawing in place (`\r`, `\x1b[K`) only means anything on a live TTY: piped, redirected, or CI
  // output takes those escapes literally. Callers are expected to skip the spinner there and log
  // plain lines instead (see runner.consume); this guard keeps a caller that forgets from corrupting
  // the stream.
  private readonly live = Boolean(process.stdout.isTTY) && !isCi()

  start(message: string): void {
    if (this.timer) return
    this.message = message
    this.frame = 0
    if (!this.live) return
    // Blank line above the live line, so the loader doesn't sit flush against the step it follows.
    // Written once here rather than in paint(): the redraw only ever rewrites its own line.
    process.stdout.write('\n')
    this.paint()
    this.timer = setInterval(() => {
      this.frame++
      this.paint()
    }, FRAME_MS)
    this.timer.unref?.() // never keep the process alive for the spinner
  }

  setMessage(message: string): void {
    this.message = message
    if (this.painted) this.paint()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
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
    return `${color.brand(glyph)} ${color.dim(this.message)}`
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
