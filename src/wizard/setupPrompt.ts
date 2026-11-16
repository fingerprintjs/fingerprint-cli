import { createPrompt, isDownKey, isEnterKey, isSpaceKey, isUpKey, makeTheme, Separator, useKeypress, usePagination, usePrefix, useState } from '@inquirer/core'
import figures from '@inquirer/figures'
import { styleText } from 'node:util'

export interface SetupChoice<T> {
  name: string
  value: T
  description?: string
}

interface Config<T> {
  message: string
  basic: SetupChoice<null>
  choices: (SetupChoice<T> | Separator)[]
}

type Item<T> = (SetupChoice<T | null> & { checked: boolean }) | Separator

// The setup question: a checkbox whose first entry, the basic installation, is exclusive with the
// rest. Ticking a use case unticks it; unticking the last use case ticks it again; ticking it
// clears the use cases. So the answer always reads as what will happen. Enter resolves to the ticked
// use cases, empty for the basic installation. (The stock checkbox cannot change one entry for
// another, which is why this exists.)
export const setupPrompt = createPrompt(<T,>(config: Config<T>, done: (value: T[]) => void) => {
  const theme = makeTheme({})
  const [status, setStatus] = useState<'idle' | 'done'>('idle')
  const prefix = usePrefix({ status, theme })
  const [items, setItems] = useState<Item<T>[]>([
    { ...config.basic, checked: true },
    ...config.choices.map((c) => (Separator.isSeparator(c) ? c : { ...c, checked: false })),
  ])
  const [active, setActive] = useState(0)
  const isChoice = (item: Item<T>): item is Exclude<Item<T>, Separator> => !Separator.isSeparator(item)

  useKeypress((key) => {
    if (isEnterKey(key)) {
      setStatus('done')
      done(items.filter(isChoice).filter((i) => i.checked && i.value !== null).map((i) => i.value as T))
    } else if (isUpKey(key) || isDownKey(key)) {
      const offset = isUpKey(key) ? -1 : 1
      let next = active
      do next = (next + offset + items.length) % items.length
      while (!isChoice(items[next]!))
      setActive(next)
    } else if (isSpaceKey(key)) {
      const current = items[active]
      if (!current || !isChoice(current)) return
      const toggled = items.map((item, i) => (i === active && isChoice(item) ? { ...item, checked: !item.checked } : item))
      const anyUseCase = toggled.some((item) => isChoice(item) && item.value !== null && item.checked)
      // Basic is a reflection of the use cases: ticked exactly when none is.
      setItems(toggled.map((item) => (isChoice(item) && item.value === null ? { ...item, checked: !anyUseCase } : item)))
    }
  })

  const message = theme.style.message(config.message, status)
  if (status === 'done') {
    const answer = items.filter(isChoice).filter((i) => i.checked).map((i) => i.name).join(', ')
    return `${prefix} ${message} ${theme.style.answer(answer)}`
  }

  let description: string | undefined
  const page = usePagination({
    items,
    active,
    pageSize: 12,
    loop: true,
    renderItem({ item, isActive }) {
      if (Separator.isSeparator(item)) return ` ${item.separator}`
      if (isActive) description = item.description
      const box = item.checked ? styleText('green', figures.circleFilled) : figures.circle
      const line = `${isActive ? figures.pointer : ' '}${box} ${item.name}`
      return isActive ? theme.style.highlight(line) : line
    },
  })
  const help = theme.style.help('↑↓ navigate • space select • ⏎ submit')
  return [`${prefix} ${message}`, page, ' ', description ? styleText('cyan', description) : '', help].filter(Boolean).join('\n')
})
