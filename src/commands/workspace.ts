import { input, select } from '@inquirer/prompts'
import { ApiClient } from '../api/client.js'
import { endpoints } from '../api/endpoints.js'
import { getAuthState, updateAuthState } from '../auth/tokenStore.js'
import { REGION_CHOICES } from '../config/config.js'
import { requireAuth } from '../utils/session.js'

export async function workspaceList() {
  const auth = requireAuth()
  const client = new ApiClient(auth.apiUrl)
  const subs = await client.request<any[]>(endpoints.subscriptions, { method: 'GET' }, true)
  subs.forEach((s) => console.log(`${s.id}	${s.name ?? ''}`))
}

export async function workspaceUse(id?: string) {
  const auth = requireAuth()
  if (!id) {
    const client = new ApiClient(auth.apiUrl)
    const subs = await client.request<any[]>(endpoints.subscriptions, { method: 'GET' }, true)
    id = await select({
      message: 'Pick workspace',
      choices: subs.map((s) => ({ name: `${s.name ?? 'workspace'} (${s.id})`, value: s.id })),
    })
  }
  updateAuthState({ currentSubscriptionId: id })
  console.log(`Using workspace: ${id}`)
}

export async function workspaceStart() {
  const auth = requireAuth()
  const client = new ApiClient(auth.apiUrl)
  const name = await input({ message: 'Workspace name' })
  const domain = await input({ message: 'Primary domain (optional)' })
  const regionCode = await select({ message: 'Server region', choices: REGION_CHOICES, default: 'use1' })
  const result = await client.request<any>(endpoints.subscriptionStart, {
    method: 'POST',
    body: JSON.stringify({
      name,
      domain: domain || undefined,
      regionCode,
      privacyPolicy: true,
      termsOfService: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  }, true)
  updateAuthState({ currentSubscriptionId: result.id })
  console.log(`Workspace created: ${result.id}`)
}
