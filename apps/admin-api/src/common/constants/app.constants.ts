/**
 * MAINT-02: Named constants for magic numbers
 * This provides a centralized definition for all magic numbers used across the application
 */

/**
 * Database-related constants
 */
export const DatabaseConstants = {
  // Batch insert chunk size for log lines
  LOG_BATCH_INSERT_SIZE: 500,
  LOG_BATCH_INSERT_SIZE_SMALL: 100,
  LOG_BATCH_INSERT_SIZE_LARGE: 200,
  LOG_BATCH_INSERT_SIZE_MEDIUM_LARGE: 300,
  LOG_BATCH_INSERT_SIZE_MAX: 1000,
  LOG_BATCH_INSERT_SIZE_MIN: 100,

  // Pagination limits
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,

  // Query timeouts
  QUERY_TIMEOUT_MS: 15000,
} as const;

/**
 * Authentication and security constants
 */
export const SecurityConstants = {
  // Token lengths
  MIN_JWT_SECRET_LENGTH: 32,
  MIN_EXECUTOR_SECRET_LENGTH: 16,
  MIN_PASSWORD_LENGTH: 16,

  // Account lockout
  MAX_LOGIN_ATTEMPTS: 5,
  ACCOUNT_LOCKOUT_DURATION_MINUTES: 30,

  // Token expiration
  JWT_DEFAULT_EXPIRES_IN: "7d",
  REFRESH_TOKEN_EXPIRES_IN_DAYS: 30,

  // Rate limiting
  RATE_LIMIT_TTL_SECONDS: 60,
  RATE_LIMIT_MAX_REQUESTS: 100,
} as const;

/**
 * Task execution constants
 */
export const TaskConstants = {
  // Default timeout values
  DEFAULT_TASK_TIMEOUT_SECONDS: 300,
  MAX_TASK_TIMEOUT_SECONDS: 3600,
  MIN_TASK_TIMEOUT_SECONDS: 10,

  // Git operations
  GIT_CLONE_TIMEOUT_SECONDS: 120,
  GIT_FETCH_TIMEOUT_SECONDS: 60,
  GIT_CHECKOUT_TIMEOUT_SECONDS: 30,

  // Retry settings
  DEFAULT_MAX_RETRY: 3,
  MAX_RETRY_LIMIT: 10,

  // Misfire detection
  MISFIRE_THRESHOLD_MULTIPLIER: 2, // multiplier for fixed_rate interval
  MISFIRE_THRESHOLD_MINUTES: 2, // for cron tasks

  // Heartbeat
  HEARTBEAT_INTERVAL_SECONDS: 30,
  EXECUTOR_TIMEOUT_MULTIPLIER: 2, // executor is considered dead after 2x heartbeat interval
} as const;

/**
 * HTTP and network constants
 */
export const NetworkConstants = {
  // Timeouts
  DEFAULT_REQUEST_TIMEOUT_MS: 5000,
  HEARTBEAT_TIMEOUT_MS: 5000,
  EXECUTOR_REQUEST_TIMEOUT_MS: 30000,

  // Connection limits
  MAX_CONCURRENT_TASKS_DEFAULT: 10,
  MAX_CONCURRENT_TASKS_LIMIT: 100,

  // Body size limits
  MAX_JSON_BODY_SIZE_MB: 1,
  MAX_URL_ENCODED_BODY_SIZE_MB: 1,
} as const;

/**
 * Audit and logging constants
 */
export const AuditConstants = {
  // Audit log retention
  AUDIT_LOG_RETENTION_DAYS: 180,

  // Log line limits
  MAX_LOG_LINE_LENGTH: 10000,
  MAX_LOG_LINES_PER_EXECUTION: 100000,

  // Action parameter limits
  MAX_ACTION_PARAM_LENGTH: 100,
} as const;

/**
 * Redis and queue constants
 */
export const QueueConstants = {
  // Retry settings
  MAX_REDIS_RETRIES: 10,
  MAX_RETRIES_PER_REQUEST: 3,
  MAX_REDIRECTIONS: 3,

  // Timeouts
  REDIS_CONNECT_TIMEOUT_MS: 10000,
  REDIS_KEEP_ALIVE_MS: 10000,
  REDIS_RETRY_DELAY_MS: 100,
  REDIS_MAX_RETRY_DELAY_MS: 3000,

  // Queue names
  TASK_QUEUE_NAME: "task-queue",
} as const;

/**
 * File system constants
 */
export const FileSystemConstants = {
  // Permissions
  WORK_DIR_PERMISSIONS: 0o700,

  // Path limits
  MAX_PATH_LENGTH: 4096,
  MAX_FILENAME_LENGTH: 255,
} as const;

/**
 * Environment constants
 */
export const EnvironmentConstants = {
  DEVELOPMENT: "development",
  PRODUCTION: "production",
  TEST: "test",
} as const;
