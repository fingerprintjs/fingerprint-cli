import { log } from '../wizard/log.js'
import { provisionForRepo } from '../wizard/provision.js'
import { applyIntegration } from '../wizard/runner.js'

// Provision the active workspace's API keys into the right per-app .env files, then offer to
// apply the Fingerprint integration to the detected repo (one continuous flow).
export async function credentialsStep() {
  const root = process.cwd()
  const needsDotenv = await provisionForRepo(root)
  if (needsDotenv.length) {
    log.warn(`Make sure these backend(s) load .env (dotenv): ${needsDotenv.map((a) => a.rel).join(', ')}`)
  }
  log.info('Add the written .env files to .gitignore.')

  await applyIntegration(root)
}
