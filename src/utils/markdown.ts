import { color } from './color.js'

// The agent narrates in markdown, which the terminal shows literally — `**Tech Stack:**`, `### Notes`,
// backticked identifiers. This renders the small subset it actually emits into ANSI, so the emphasis
// survives and the syntax doesn't. Not a markdown parser: anything unrecognized passes through
// unchanged, which is the right failure mode for text we don't control.
export function renderMarkdown(text: string): string {
  return text.split('\n').map(renderLine).join('\n')
}

function renderLine(line: string): string {
  // ATX heading (`### Notes`) → bold, hashes dropped. They carry no weight at this size.
  const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
  if (heading) return color.bold(inline(heading[2]))

  // Bullet → `•`, keeping the indent so nesting still reads.
  const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line)
  if (bullet) return `${bullet[1]}${color.dim('•')} ${inline(bullet[2])}`

  return inline(line)
}

// Code spans first: they're the one place `**` should stay literal, and replacing them first means
// the bold pass sees escape codes (which contain no `*`) rather than the original delimiters.
function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_, code: string) => color.cyan(code))
    .replace(/\*\*([^*]+)\*\*/g, (_, bold: string) => color.bold(bold))
}
