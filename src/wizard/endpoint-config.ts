// Recognize endpoint values in provider options, rather than comments or unused variable mentions.
// A token scan rather than a parser: it has to read .vue, .svelte, .astro and .html alongside JS and
// TS without adding a runtime dependency, and the question is narrow (is the subdomain, or the env
// variable holding it, what `endpoints` is given), so the few value shapes agents write are enough.
export function referencesEndpoint(code: string, endpoint: string, envVar?: string): boolean {
  const tokens = (code.match(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\?\?|\|\||&&|[\w$]+|\n|[^\s]/g) ?? [])
    .filter((token) => !token.startsWith('//') && !token.startsWith('/*') && !token.startsWith('<!--'))
  const declarations = new Map<string, string[]>()
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'const' || !/^[A-Za-z_$][\w$]*$/.test(tokens[i + 1] ?? '')) continue
    // `const x = ...` or, in TypeScript, `const x: SomeType = ...`.
    let assign = i + 2
    if (tokens[assign] === ':') assign = topLevelIndex(tokens, '=', assign + 1)
    if (tokens[assign] === '=') {
      let start = assign + 1
      while (tokens[start] === '\n') start++
      declarations.set(tokens[i + 1], readValue(tokens, start, true).filter((token) => token !== '\n'))
    }
  }
  const source = tokens.filter((token) => token !== '\n')
  const matches = (value: string[], seen = new Set<string>()): boolean => {
    while (value[0] === '(' && closingIndex(value, 0) === value.length - 1) value = value.slice(1, -1)
    if (value.at(-1) === '!') return matches(value.slice(0, -1), seen)
    const assertion = topLevelIndex(value, 'as')
    if (assertion >= 0) {
      return /^(string|undefined|\||\[|\])+$/.test(value.slice(assertion + 1).join('')) && matches(value.slice(0, assertion), seen)
    }

    const question = topLevelIndex(value, '?')
    if (question >= 0) {
      const colon = topLevelIndex(value, ':', question + 1)
      return colon >= 0 && matches(value.slice(0, question), seen) && matches(value.slice(question + 1, colon), seen)
    }
    for (const operator of ['??', '||', '&&']) {
      const index = topLevelIndex(value, operator)
      if (index >= 0) {
        // The CLI writes a non-empty endpoint, so its ??/|| fallback is not taken.
        return matches(value.slice(0, index), seen) && (operator !== '&&' || matches(value.slice(index + 1), seen))
      }
    }
    if (value[0] === '[' && closingIndex(value, 0) === value.length - 1) {
      // The selected subdomain must be the primary endpoint, not just a fallback.
      return matches(readValue(value.slice(1, -1), 0), seen)
    }
    if (value.length === 1) {
      if ([`"${endpoint}"`, `'${endpoint}'`, '`' + endpoint + '`'].includes(value[0])) return true
      const declaration = declarations.get(value[0])
      if (declaration && !seen.has(value[0])) return matches(declaration, new Set([...seen, value[0]]))
    }
    if (!envVar) return false
    return ['import.meta.env', 'process.env'].some((prefix) =>
      [`${prefix}.${envVar}`, `${prefix}["${envVar}"]`, `${prefix}['${envVar}']`].includes(value.join(''))
    )
  }

  for (let i = 0; i < source.length; i++) {
    if (!['endpoints', '"endpoints"', "'endpoints'"].includes(source[i])) continue
    const jsx = source[i + 1] === '=' && inOpeningTag(source, i)
    if (source[i + 1] === ':' || jsx) {
      const start = i + 2
      const value = jsx && source[start] === '{'
        ? source.slice(start + 1, closingIndex(source, start))
        : jsx ? [source[start]] : readValue(source, start)
      if (matches(value)) return true
    } else if (source[i] === 'endpoints' && ['{', ','].includes(source[i - 1]) && [',', '}'].includes(source[i + 1])) {
      if (matches(['endpoints'])) return true
    }
  }
  return false
}

function readValue(source: string[], start: number, stopAtNewline = false): string[] {
  let depth = 0
  let end = start
  for (; end < source.length; end++) {
    const token = source[end]
    if (depth === 0 && ([',', ';', '}', ']', ')', '>'].includes(token) || (stopAtNewline && token === '\n'))) break
    if (['{', '[', '('].includes(token)) depth++
    if (['}', ']', ')'].includes(token)) depth--
  }
  return source.slice(start, end)
}

function closingIndex(source: string[], start: number): number {
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (['{', '[', '('].includes(source[i])) depth++
    if (['}', ']', ')'].includes(source[i]) && --depth === 0) return i
  }
  return source.length
}

function topLevelIndex(source: string[], token: string, start = 0): number {
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (depth === 0 && source[i] === token) return i
    if (['{', '[', '('].includes(source[i])) depth++
    if (['}', ']', ')'].includes(source[i])) depth--
  }
  return -1
}

function inOpeningTag(source: string[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    if (source[i] === '>' || source[i] === ';') return false
    if (source[i] === '<') return /^[A-Za-z_$]/.test(source[i + 1])
  }
  return false
}
