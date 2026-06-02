import * as readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

// Read a line of text in the terminal's canonical (cooked) mode. Unlike raw-mode prompt
// libraries, this lets the OS compose AltGr/Option characters such as `@`, `#`, `{` on
// non-US keyboard layouts, so users can type their email/name normally.
export async function text(message: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    const answer = await rl.question(`${message}: `)
    return answer.trim()
  } finally {
    rl.close()
  }
}
