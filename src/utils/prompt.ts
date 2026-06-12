import * as readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { isCi } from './ci.js'

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
