import { readFileSync } from 'node:fs'

interface PackageMetadata {
  version: string
}

// `src/version.ts` and the compiled `dist/version.js` are both one level below package.json.
// npm always includes package.json in the published package, so this remains the single version
// source that Changesets updates.
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageMetadata

export const VERSION = metadata.version
