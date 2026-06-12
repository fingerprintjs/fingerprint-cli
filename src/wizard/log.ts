import chalk from 'chalk'
import { debugLog } from '../utils/log-file.js'

// Status-symbol logging for the wizard, including streamed agent steps. Each line is also teed
// to the verbose run log (see log-file.ts) so a failed integration leaves a trail to inspect.
export const log = {
  info: (m: string) => (console.log(`${chalk.dim('│')} ${m}`), debugLog(`info  ${m}`)),
  step: (m: string) => (console.log(`${chalk.cyan('◇')} ${m}`), debugLog(`step  ${m}`)),
  success: (m: string) => (console.log(`${chalk.green('✔')} ${m}`), debugLog(`ok    ${m}`)),
  warn: (m: string) => (console.log(`${chalk.yellow('▲')} ${m}`), debugLog(`warn  ${m}`)),
  error: (m: string) => (console.log(`${chalk.red('✖')} ${m}`), debugLog(`error ${m}`)),
  tool: (name: string, detail?: string) => (
    console.log(`${chalk.magenta('●')} ${chalk.bold(name)}${detail ? chalk.dim(` ${detail}`) : ''}`),
    debugLog(`tool  ${name}${detail ? ` ${detail}` : ''}`)
  ),
}
