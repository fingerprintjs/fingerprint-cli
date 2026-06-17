// Interactive mode. Off by default — the wizard applies edits and installs packages automatically
// ("auto mode"). With --interactive (seeded in index.ts), the wizard asks the developer before each
// file edit and each package install. Always off in CI, where there's no one to answer the prompt.
let interactive = false

export function setInteractive(v: boolean): void {
  interactive = v
}

export function isInteractive(): boolean {
  return interactive
}
