import { color, isColorEnabled } from './color.js'

// Plain strings (not a template literal) so `/`, `\`, and `` ` `` in the art stay literal.
const BANNER = `
███████╗██╗███╗   ██╗ ██████╗ ███████╗██████╗ ██████╗ ██████╗ ██╗███╗   ██╗████████╗     ██████╗██╗     ██╗
██╔════╝██║████╗  ██║██╔════╝ ██╔════╝██╔══██╗██╔══██╗██╔══██╗██║████╗  ██║╚══██╔══╝    ██╔════╝██║     ██║
█████╗  ██║██╔██╗ ██║██║  ███╗█████╗  ██████╔╝██████╔╝██████╔╝██║██╔██╗ ██║   ██║       ██║     ██║     ██║
██╔══╝  ██║██║╚██╗██║██║   ██║██╔══╝  ██╔══██╗██╔═══╝ ██╔══██╗██║██║╚██╗██║   ██║       ██║     ██║     ██║
██║     ██║██║ ╚████║╚██████╔╝███████╗██║  ██║██║     ██║  ██║██║██║ ╚████║   ██║       ╚██████╗███████╗██║
╚═╝     ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝   ╚═╝        ╚═════╝╚══════╝╚═╝
`.trim()

// Match color.ts: only emit truecolor escapes when stdout is a TTY and NO_COLOR isn't set.
const RESET = '\x1b[0m'
const paint = (escape: string, text: string) =>
  isColorEnabled ? `${escape}${text}${RESET}` : text

// Top to bottom gradient for fill & shadows
const LINE_FILLS = [
  '\x1b[38;2;246;132;90m', // #F6845A
  '\x1b[38;2;246;121;76m', // #F6794C
  '\x1b[38;2;245;110;61m', // #F56E3D
  '\x1b[38;2;244;99;47m', // #F4632F
  '\x1b[38;2;243;91;34m', // #F35B22
].map((escape) => (t: string) => paint(escape, t))

const LINE_SHADOWS = [
  '\x1b[38;2;124;76;60m', // #7C4C3C
  '\x1b[38;2;114;70;54m', // #724636
  '\x1b[38;2;103;64;50m', // #674032
  '\x1b[38;2;93;57;45m',  // #5D392D
  '\x1b[38;2;83;51;40m',  // #533328
  '\x1b[38;2;72;45;35m',  // #482D23
].map((escape) => (t: string) => paint(escape, t))

function colorizeLine(line: string, lineIndex: number): string {
  const fill = LINE_FILLS[lineIndex]
  const shadow = LINE_SHADOWS[lineIndex]
  let out = ''
  for (const ch of line) {
    if (ch === ' ') out += ch
    else if (ch === '█' && fill) out += fill(ch)
    else if (shadow) out += shadow(ch)
    else out += ch
  }
  return out
}

const BOTTOM_LABEL = ' v0.1.0 '
const PAD = 3 // spaces on each side of the art

export function printFiglet(): void {
  const lines = BANNER.split('\n')
  const contentWidth = Math.max(...lines.map((l) => l.length))
  const innerWidth = contentWidth + PAD * 2

  // Corner art: ╭─                        ─╮
  const topGap = Math.max(1, innerWidth - 4)
  const top = color.dim(`╭─${' '.repeat(topGap)}─╮`)

  const body = lines.map((line, i) => {
    const art = colorizeLine(line.padEnd(contentWidth), i)
    return `${' '.repeat(PAD)}${art}${' '.repeat(PAD)}`
  })

  // ╰─                   v0.1.0 ─╯
  const bottomGap = Math.max(1, innerWidth - BOTTOM_LABEL.length - 4)
  const bottom = color.dim(`╰─${' '.repeat(bottomGap)}${BOTTOM_LABEL}─╯`)

  console.log([top, ...body, bottom].join('\n'))
}
