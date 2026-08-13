import { styleText } from 'node:util'

// Minimal stdlib replacement for chalk, built on node:util.styleText (Node >= 20.12). Colorize only
// when stdout is a TTY and NO_COLOR isn't set, matching chalk's default so piped/CI output stays
// plain. Only the styles the wizard actually uses are exposed.
export const isColorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

type Style = 'dim' | 'green' | 'yellow' | 'red' | 'magenta' | 'cyan' | 'bold'
const paint = (style: Style) => (text: string) => (isColorEnabled ? styleText(style, text) : text)

// Fingerprint brand orange. styleText has no named orange, so we use a truecolor escape
// when color is enabled; otherwise return the text unchanged.
const ORANGE_5 = '\x1b[38;2;254;168;140m'
const RESET = '\x1b[0m'
const brand = (text: string) => (isColorEnabled ? `${ORANGE_5}${text}${RESET}` : text)

/** Cyan-background label used for section headings (Clack-style `intro`). */
const badge = (text: string) =>
  isColorEnabled ? styleText(['bgCyan', 'black'], ` ${text} `) : ` ${text} `

export const color = {
  dim: paint('dim'),
  green: paint('green'),
  yellow: paint('yellow'),
  red: paint('red'),
  magenta: paint('magenta'),
  cyan: paint('cyan'),
  bold: paint('bold'),
  brand,
  badge,
}

// Small branded header used at the start of auth / setup flows.
export function banner(subtitle?: string): void {
  const title = color.brand(color.bold('Fingerprint'))
  const line = subtitle ? `${title} ${color.dim('·')} ${subtitle}` : title
  console.log(`\n${line}`)
}
