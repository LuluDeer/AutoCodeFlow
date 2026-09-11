// UI-10 English copy. Keys mirror zh.ts exactly (see zh.ts for structure).
// Missing keys fall back to zh via i18next fallbackLng.
export default {
  'brand.tagline': 'Enterprise task orchestration platform',
  'brand.edition': 'AutoCodeFlow v1.0 · Enterprise',

  'login.account': 'Sign in',
  'login.twoFactor': 'Two-factor verification',
  'login.username': 'Username',
  'login.password': 'Password',
  'login.password.placeholder': 'Password',
  'login.username.required': 'Please enter username',
  'login.password.required': 'Please enter password',
  'login.username.aria': 'Username',
  'login.password.aria': 'Password',
  'login.username.placeholder': 'admin',
  'login.submit': 'Sign in',
  'login.verifySubmit': 'Verify & sign in',
  'login.credentialsMissing': 'Login response missing credentials',
  'login.badCredentials': 'Incorrect username or password',
  'login.totpCode': 'Verification code',
  'login.totpCode.required': 'Please enter the 6-digit verification code',
  'login.totpCode.placeholder': '6-digit code',
  'login.totpCode.aria': 'Verification code',
  'login.totpCode.invalid': 'Incorrect verification code',
  'login.totpHint': 'Open your authenticator app for the code',
  'login.forgotHint': 'Forgot password? Contact an administrator to reset it',
} as const;