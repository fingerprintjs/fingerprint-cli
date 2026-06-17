// Verbose mode. Seeded once from the global --verbose flag in index.ts, then read by the wizard
// runner to decide whether to stream the agent's per-step tool calls (Read/Glob/Edit/...).
let verbose = false

export function setVerbose(v: boolean): void {
  verbose = v
}

export function isVerbose(): boolean {
  return verbose
}
