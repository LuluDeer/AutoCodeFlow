/**
 * ARCH-27: the ONLY sanctioned `process.env` escape hatch outside
 * configuration.ts. The ESLint rule `no-restricted-properties`
 * (see .eslintrc.js) bans direct `process.env` reads everywhere else.
 *
 * Why this exists — the W-22 precedent: some values are evaluated at
 * MODULE-LOAD time (decorator arguments such as auth.controller's
 * @Throttle limit, module-level constants), which happens when a module
 * first enters the import graph — BEFORE ConfigModule's lifecycle applies
 * the `.env` file. Reading via ConfigService in those positions would
 * freeze a dead/empty value (exactly the dead-config bug W-22 shipped).
 *
 * main.ts mitigates the timing by preloading `.env` before app.module is
 * imported; this util additionally centralizes the remaining load-time
 * reads so they are greppable, reviewed in one place, and carry the same
 * caveat. Runtime code must NOT use this — inject ConfigService instead.
 *
 * W-22 history: see src/__tests__/main-env-preload.spec.ts and the
 * config-read convention note at the top of configuration.ts.
 */

/**
 * Read an environment variable at module-evaluation time.
 *
 * Exemption rationale (per ARCH-27): only call this where a value MUST be
 * resolved before Nest DI exists (decorator args / module constants). Every
 * call site must carry a W-22 comment explaining why ConfigService cannot
 * be used at that position.
 */
export const getEnvVar = (name: string): string | undefined =>
  process.env[name];
