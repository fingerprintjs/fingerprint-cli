import { select as inquirerSelect } from '@inquirer/prompts'
import { color } from './color.js'

// Inquirer defaults highlight + answer to cyan; brand those magenta once for every select.
const selectTheme = {
  style: {
    highlight: (text: string) => color.magenta(text),
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
