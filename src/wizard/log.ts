import chalk from 'chalk'

// Status-symbol logging for the wizard, including streamed agent steps.
export const log = {
  info: (m: string) => console.log(`${chalk.dim('│')} ${m}`),
  step: (m: string) => console.log(`${chalk.cyan('◇')} ${m}`),
  success: (m: string) => console.log(`${chalk.green('✔')} ${m}`),
  warn: (m: string) => console.log(`${chalk.yellow('▲')} ${m}`),
  error: (m: string) => console.log(`${chalk.red('✖')} ${m}`),
  tool: (name: string, detail?: string) =>
    console.log(`${chalk.magenta('●')} ${chalk.bold(name)}${detail ? chalk.dim(` ${detail}`) : ''}`),
}
