import { styleText } from 'node:util'

// Minimal stdlib replacement for chalk, built on node:util.styleText (Node >= 20.12). Colorize only
// when stdout is a TTY and NO_COLOR isn't set, matching chalk's default so piped/CI output stays
// plain. Only the styles the wizard actually uses are exposed.
const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

type Style = 'cyan' | 'dim' | 'green' | 'yellow' | 'red' | 'magenta' | 'bold'
const paint = (style: Style) => (text: string) => (enabled ? styleText(style, text) : text)

export const color = {
  cyan: paint('cyan'),
  dim: paint('dim'),
  green: paint('green'),
  yellow: paint('yellow'),
  red: paint('red'),
  magenta: paint('magenta'),
  bold: paint('bold'),
}
