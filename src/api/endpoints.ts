export const endpoints = {
  signupIntentCreate: '/signup',
  signupIntentConfirm: '/signup/confirm',
  passwordStrength: '/signup/password_strength',
  login: '/login',
  logout: '/logout',
  currentUserGet: '/users/me',
  subscriptions: '/subscriptions',
  subscriptionStart: '/subscriptions/start',
  onboardingSkip: '/onboarding/skip',
  tokens: (subscriptionId: string) => `/subscriptions/${subscriptionId}/tokens`,
  ssoAuth: '/sso/auth',
}
