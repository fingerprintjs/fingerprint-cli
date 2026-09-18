import { ManagementApiError } from './management.js'
import { NotAuthenticatedError } from '../utils/session.js'

const UNAVAILABLE_MESSAGE =
  'Custom subdomain service is unavailable. This may be temporary, or the feature may be disabled. ' +
  'Check availability with Fingerprint support before retrying.'

export type SubdomainErrorKind =
  | 'not_authenticated'
  | 'invalid_subdomain'
  | 'duplicate'
  | 'limit_reached'
  | 'rate_limited'
  | 'unavailable'
  | 'not_found'
  | 'api_error'

export function serializeSubdomainError(error: unknown): Record<string, unknown> {
  if (error instanceof NotAuthenticatedError) return { kind: 'not_authenticated', message: error.message }
  if (!(error instanceof ManagementApiError)) {
    return { kind: 'api_error', message: error instanceof Error ? error.message : String(error) }
  }

  return {
    kind: subdomainErrorKind(error),
    message: apiErrorMessage(error),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.violations?.length ? { violations: error.violations } : {}),
    ...(error.retryAfter === undefined ? {} : { retry_after: error.retryAfter }),
  }
}

export function apiErrorMessage(error: ManagementApiError): string {
  if (error.status === 401) return `${error.message.replace(/[.!?]*$/, '')}. Run: fingerprint login`
  if (error.status === 503) return UNAVAILABLE_MESSAGE
  return error.message
}

export function subdomainErrorKind(error: unknown): SubdomainErrorKind {
  if (error instanceof NotAuthenticatedError) return 'not_authenticated'
  if (!(error instanceof ManagementApiError)) return 'api_error'
  if (error.status === 401) return 'not_authenticated'
  // Runtime currently returns 400 for limits, while the published contract documents 409.
  if (
    (error.status === 400 || error.status === 409) &&
    /limit.*subdomains|subdomains.*limit/i.test(error.message)
  ) {
    return 'limit_reached'
  }
  if (error.status === 422) return 'invalid_subdomain'
  if (error.status === 409) return 'duplicate'
  if (error.status === 429) return 'rate_limited'
  if (error.status === 404) return 'not_found'
  if (error.status === 503) return 'unavailable'
  return 'api_error'
}
