import * as readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { select as inquirerSelect } from '@inquirer/prompts'
import { isCi } from './ci.js'
import { color } from './color.js'

// Inquirer defaults highlight + answer to cyan; brand those magenta once for every select.
const selectTheme = {
  style: {
    highlight: (text: string) => color.brand(text),
    answer: (text: string) => color.green(text),
  },
}

export function select<Value>(
  config: Parameters<typeof inquirerSelect<Value>>[0],
): ReturnType<typeof inquirerSelect<Value>> {
  return inquirerSelect({
    ...config,
    theme: {
      ...config.theme,
      style: {
        ...selectTheme.style,
        ...config.theme?.style,
      },
    },
  })
}

// Read a line of text in the terminal's canonical (cooked) mode. Unlike raw-mode prompt
// libraries, this lets the OS compose AltGr/Option characters such as `@`, `#`, `{` on
// non-US keyboard layouts, so users can type their email/name normally.
export async function text(message: string): Promise<string> {
  // No stdin to read in CI — fail fast with the prompt text so the missing input is obvious.
  if (isCi()) throw new Error(`Missing required input in non-interactive mode: ${message}`)
  // Ensure the TTY stays in canonical mode (terminal:false stops readline from switching to
  // raw mode, where Option/AltGr-composed chars like `@` get parsed as escape sequences).
  if (stdin.isTTY) stdin.setRawMode?.(false)
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false })
  try {
    stdout.write(`${message}: `)
    const answer = await rl.question('')
    return answer.trim()
  } finally {
    rl.close()
  }
}
