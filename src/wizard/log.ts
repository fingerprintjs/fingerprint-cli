import { color } from '../utils/color.js'
import { debugLog } from '../utils/log-file.js'

// Status-symbol logging for the wizard, including streamed agent steps. Each line is also teed
// to the verbose run log (see log-file.ts) so a failed integration leaves a trail to inspect.
export const log = {
  info: (m: string) => (console.log(`${color.dim('│')} ${m}`), debugLog(`info  ${m}`)),
  step: (m: string) => (console.log(`${color.cyan('◇')} ${m}`), debugLog(`step  ${m}`)),
  success: (m: string) => (console.log(`${color.green('✔')} ${m}`), debugLog(`ok    ${m}`)),
  warn: (m: string) => (console.log(`${color.yellow('▲')} ${m}`), debugLog(`warn  ${m}`)),
  error: (m: string) => (console.log(`${color.red('✖')} ${m}`), debugLog(`error ${m}`)),
  tool: (name: string, detail?: string) => (
    console.log(`${color.magenta('●')} ${color.bold(name)}${detail ? color.dim(` ${detail}`) : ''}`),
    debugLog(`tool  ${name}${detail ? ` ${detail}` : ''}`)
  ),
}
