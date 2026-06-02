export const DEFAULT_API_URL = process.env.FINGERPRINT_API_URL ?? 'https://mgmtapi.fpjs.sh'

export type Region = 'us' | 'eu' | 'ap'

export interface RuntimeConfig {
  apiUrl: string
  region: Region
}

export function resolveConfig(apiUrl?: string, region?: string): RuntimeConfig {
  const resolvedRegion = (region ?? process.env.FINGERPRINT_REGION ?? 'us') as Region
  return {
    apiUrl: apiUrl ?? DEFAULT_API_URL,
    region: resolvedRegion,
  }
}

// Server region codes accepted by POST /subscriptions/start (mirrors the dashboard's REGIONS).
export type RegionCode = 'use1' | 'euc1' | 'aps1'

export const REGION_CHOICES: { name: string; value: RegionCode }[] = [
  { name: 'North America — Virginia (use1) — Most popular', value: 'use1' },
  { name: 'Europe — Frankfurt (euc1)', value: 'euc1' },
  { name: 'Asia Pacific — Mumbai (aps1)', value: 'aps1' },
]
