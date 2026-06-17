import { log } from '../wizard/log.js'
import { provisionForRepo } from '../wizard/provision.js'
import { applyIntegration } from '../wizard/runner.js'

// Provision the active workspace's API keys into the right per-app .env files, then offer to
// apply the Fingerprint integration to the detected repo (one continuous flow).
export async function credentialsStep() {
  const root = process.cwd()
  const { needsDotenv, externalBackends } = await provisionForRepo(root)
  if (needsDotenv.length) {
    log.warn(`Make sure these backend(s) load .env (dotenv): ${needsDotenv.map((a) => a.rel).join(', ')}`)
  }

  await applyIntegration(root)

  // Integrate any backend that lives outside this repo (found via the backend-path prompt) — the
  // repo-scoped pass above can't see it, so give each its own agent run.
  for (const be of externalBackends) {
    log.step(`Integrate backend at ${be.dir}`)
    await applyIntegration(be.dir)
  }
}
