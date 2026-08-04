import { color } from '../utils/color.js'
import { debugLog } from '../utils/log-file.js'

// Clack-style status logging for the wizard: a symbol column, bold section titles, and a dim
// vertical rail (`│`) grouping detail under each step. Each line is also teed to the verbose run
// log (see log-file.ts) so a failed integration leaves a trail to inspect.
//
// Hierarchy:
//     heading  — cyan badge that opens a phase (next step connects with │)
//   ◇ step     — section header (blank before first; connector │ if a section is still open)
//   │ info     — detail under the current section
//   ✔ success  — completed outcome
//   ▲ warn     — inline warning
//   ✖ error    — failure
//   └ end      — closes the final section (next header starts fresh with a blank)

const BAR = '│'
const LABEL_WIDTH = 11
const DOCS_DEFAULT = 'https://dev.fingerprint.com/docs'

// True after a section header until `end` — next header gets a connector rail instead of a blank.
let sectionOpen = false

function emit(symbol: string, message: string, debugKind: string): void {
  console.log(`${symbol}${message ? ` ${message}` : ''}`)
  debugLog(`${debugKind.padEnd(5)} ${message}`)
}

function withRail(message: string, debugKind: string): void {
  for (const line of message.split('\n')) {
    emit(color.dim(BAR), line, debugKind)
  }
}

// Start a section: blank before the first; connector `│` under an open section so rails join.
function beginSection(symbol: string, message: string, debugKind: string): void {
  if (sectionOpen) {
    emit(color.dim(BAR), '', 'info')
  } else {
    console.log()
  }
  emit(symbol, message, debugKind)
  sectionOpen = true
}

export const log = {
  // Blank line between sections (no rail).
  blank: () => {
    console.log()
    debugLog('blank')
  },

  // Empty rail row — breathing room inside a section.
  line: () => emit(color.dim(BAR), '', 'info'),

  // Command heading: cyan badge (` integrate `). Leaves the section open so the next
  // `step` draws a connector rail under the badge.
  heading: (m: string) => {
    if (sectionOpen) {
      emit(color.dim(BAR), '', 'info')
    } else {
      console.log()
    }
    console.log(color.badge(m))
    debugLog(`head  ${m}`)
    sectionOpen = true
  },

  // Section header. Continues the rail from the previous open section.
  step: (m: string) => beginSection(color.cyan('◇'), color.bold(m), 'step'),

  // Detail under the current section (multi-line → one rail per line).
  info: (m: string) => withRail(m, 'info'),

  // Aligned key/value under the rail (`Repository  ~/…`).
  kv: (label: string, value: string) => {
    withRail(`${color.dim(label.padEnd(LABEL_WIDTH))} ${value}`, 'info')
  },

  success: (m: string) => emit(color.green('✔'), m, 'ok'),

  warn: (m: string) => emit(color.yellow('▲'), m, 'warn'),

  error: (m: string) => emit(color.red('✖'), m, 'error'),

  tool: (name: string, detail?: string) => {
    emit(color.magenta('●'), `${color.bold(name)}${detail ? color.dim(` ${detail}`) : ''}`, 'tool')
  },

  // Terminates the current section (`└`).
  end: () => {
    emit(color.dim('└'), '', 'end')
    sectionOpen = false
  },
}

export interface FailureRecovery {
  command: string
  description: string
}

export interface FailureBlock {
  title: string
  reason: string
  recoveries: FailureRecovery[]
  docsUrl?: string
}

// Terminal failure block: yellow section header + reason + recoveries + docs, closed with `└`.
export function printFailure(block: FailureBlock): void {
  beginSection(color.yellow('▲'), color.yellow(color.bold(block.title)), 'warn')
  log.info(block.reason)
  log.line()
  log.info('Try:')
  const cmdWidth = Math.max(...block.recoveries.map((r) => r.command.length), 8)
  for (const r of block.recoveries) {
    log.info(`  ${color.green(r.command.padEnd(cmdWidth))}  ${color.dim(r.description)}`)
  }
  log.line()
  log.kv('Docs', color.dim(block.docsUrl ?? DOCS_DEFAULT))
  log.end()
}
