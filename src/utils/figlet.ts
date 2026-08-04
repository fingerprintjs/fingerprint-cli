import { color } from './color.js'

// Plain strings (not a template literal) so `/`, `\`, and `` ` `` in the art stay literal.
const BANNER = `
███████╗██╗███╗   ██╗ ██████╗ ███████╗██████╗ ██████╗ ██████╗ ██╗███╗   ██╗████████╗     ██████╗██╗     ██╗
██╔════╝██║████╗  ██║██╔════╝ ██╔════╝██╔══██╗██╔══██╗██╔══██╗██║████╗  ██║╚══██╔══╝    ██╔════╝██║     ██║
█████╗  ██║██╔██╗ ██║██║  ███╗█████╗  ██████╔╝██████╔╝██████╔╝██║██╔██╗ ██║   ██║       ██║     ██║     ██║
██╔══╝  ██║██║╚██╗██║██║   ██║██╔══╝  ██╔══██╗██╔═══╝ ██╔══██╗██║██║╚██╗██║   ██║       ██║     ██║     ██║
██║     ██║██║ ╚████║╚██████╔╝███████╗██║  ██║██║     ██║  ██║██║██║ ╚████║   ██║       ╚██████╗███████╗██║
╚═╝     ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝   ╚═╝        ╚═════╝╚══════╝╚═╝
`.trim()

// const TOP_LABEL = ' Welcome to the '
const BOTTOM_LABEL = ' v0.1.0 '
const PAD = 3 // spaces on each side of the art

export function printFiglet(): void {
  const lines = BANNER.split('\n')
  const contentWidth = Math.max(...lines.map((l) => l.length))
  const innerWidth = contentWidth + PAD * 2

  // Corners only (camera focus): ╭─                        ─╮
  const topGap = Math.max(1, innerWidth - 4)
  const top = color.dim(`╭─${' '.repeat(topGap)}─╮`)

  const body = lines.map((line) => {
    const art = color.brand(line.padEnd(contentWidth))
    return `${' '.repeat(PAD)}${art}${' '.repeat(PAD)}`
  })

  // ╰─                   v0.1.0 ─╯
  const bottomGap = Math.max(1, innerWidth - BOTTOM_LABEL.length - 4)
  const bottom = color.dim(`╰─${' '.repeat(bottomGap)}${BOTTOM_LABEL}─╯`)

  console.log([top, ...body, bottom].join('\n'))
}
