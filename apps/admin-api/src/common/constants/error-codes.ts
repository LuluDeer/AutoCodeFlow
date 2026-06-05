/**
 * MAINT-01: Unified error code system
 * This provides a centralized error code definition for consistent error handling across the application
 */

export enum ErrorCode {
  // Authentication errors (AUTH_*)
  AUTH_INVALID_TOKEN = 'AUTH_001',
  AUTH_TOKEN_EXPIRED = 'AUTH_002',
  AUTH_INVALID_CREDENTIALS = 'AUTH_003',
  AUTH_ACCOUNT_LOCKED = 'AUTH_004',
  AUTH_UNAUTHORIZED = 'AUTH_005',
  AUTH_REFRESH_TOKEN_INVALID = 'AUTH_006',

  // Task errors (TASK_*)
  TASK_NOT_FOUND = 'TASK_001',
  TASK_ALREADY_EXISTS = 'TASK_002',
  TASK_INVALID_STATUS = 'TASK_003',
  TASK_EXECUTION_FAILED = 'TASK_004',
  TASK_TIMEOUT = 'TASK_005',
  TASK_INVALID_TRIGGER_TYPE = 'TASK_006',
  TASK_INVALID_CRON_EXPRESSION = 'TASK_007',
  TASK_DEPENDENCY_NOT_MET = 'TASK_008',

  // Execution errors (EXEC_*)
  EXEC_NOT_FOUND = 'EXEC_001',
  EXEC_ALREADY_RUNNING = 'EXEC_002',
  EXEC_INVALID_STATUS = 'EXEC_003',
  EXEC_LOG_FETCH_FAILED = 'EXEC_004',

  // Executor errors (EXECUTOR_*)
  EXECUTOR_NOT_FOUND = 'EXECUTOR_001',
  EXECUTOR_UNAVAILABLE = 'EXECUTOR_002',
  EXECUTOR_REGISTRATION_FAILED = 'EXECUTOR_003',
  EXECUTOR_HEARTBEAT_FAILED = 'EXECUTOR_004',
  EXECUTOR_AT_CAPACITY = 'EXECUTOR_005',

  // User errors (USER_*)
  USER_NOT_FOUND = 'USER_001',
  USER_ALREADY_EXISTS = 'USER_002',
  USER_INVALID_CREDENTIALS = 'USER_003',
  USER_PERMISSION_DENIED = 'USER_004',

  // Database errors (DB_*)
  DB_CONNECTION_FAILED = 'DB_001',
  DB_QUERY_FAILED = 'DB_002',
  DB_TRANSACTION_FAILED = 'DB_003',
  DB_UNIQUE_CONSTRAINT_VIOLATION = 'DB_004',

  // Validation errors (VALIDATION_*)
  VALIDATION_FAILED = 'VAL_001',
  VALIDATION_INVALID_INPUT = 'VAL_002',
  VALIDATION_MISSING_REQUIRED_FIELD = 'VAL_003',
  VALIDATION_INVALID_FORMAT = 'VAL_004',

  // Configuration errors (CONFIG_*)
  CONFIG_NOT_FOUND = 'CONFIG_001',
  CONFIG_INVALID_VALUE = 'CONFIG_002',
  CONFIG_LOAD_FAILED = 'CONFIG_003',

  // Notification errors (NOTIF_*)
  NOTIF_SEND_FAILED = 'NOTIF_001',
  NOTIF_INVALID_CHANNEL = 'NOTIF_002',
  NOTIF_CONFIGURATION_MISSING = 'NOTIF_003',

  // AI service errors (AI_*)
  AI_SERVICE_UNAVAILABLE = 'AI_001',
  AI_ANALYSIS_FAILED = 'AI_002',
  AI_INVALID_RESPONSE = 'AI_003',

  // Security errors (SEC_*)
  SEC_PATH_TRAVERSAL = 'SEC_001',
  SEC_SQL_INJECTION = 'SEC_002',
  SEC_XSS_ATTACK = 'SEC_003',
  SEC_CSRF_ATTACK = 'SEC_004',
  SEC_RATE_LIMIT_EXCEEDED = 'SEC_005',

  // System errors (SYS_*)
  SYS_INTERNAL_ERROR = 'SYS_001',
  SYS_SERVICE_UNAVAILABLE = 'SYS_002',
  SYS_TIMEOUT = 'SYS_003',
  SYS_RESOURCE_EXHAUSTED = 'SYS_004',
}

/**
 * Error message mapping for each error code
 */
export const ErrorMessages: Record<ErrorCode, string> = {
  // Authentication errors
  [ErrorCode.AUTH_INVALID_TOKEN]: 'Invalid authentication token',
  [ErrorCode.AUTH_TOKEN_EXPIRED]: 'Authentication token has expired',
  [ErrorCode.AUTH_INVALID_CREDENTIALS]: 'Invalid username or password',
  [ErrorCode.AUTH_ACCOUNT_LOCKED]: 'Account is locked due to too many failed attempts',
  [ErrorCode.AUTH_UNAUTHORIZED]: 'Unauthorized access',
  [ErrorCode.AUTH_REFRESH_TOKEN_INVALID]: 'Invalid or expired refresh token',

  // Task errors
  [ErrorCode.TASK_NOT_FOUND]: 'Task not found',
  [ErrorCode.TASK_ALREADY_EXISTS]: 'Task already exists',
  [ErrorCode.TASK_INVALID_STATUS]: 'Invalid task status',
  [ErrorCode.TASK_EXECUTION_FAILED]: 'Task execution failed',
  [ErrorCode.TASK_TIMEOUT]: 'Task execution timed out',
  [ErrorCode.TASK_INVALID_TRIGGER_TYPE]: 'Invalid trigger type',
  [ErrorCode.TASK_INVALID_CRON_EXPRESSION]: 'Invalid cron expression',
  [ErrorCode.TASK_DEPENDENCY_NOT_MET]: 'Task dependencies not met',

  // Execution errors
  [ErrorCode.EXEC_NOT_FOUND]: 'Execution not found',
  [ErrorCode.EXEC_ALREADY_RUNNING]: 'Execution is already running',
  [ErrorCode.EXEC_INVALID_STATUS]: 'Invalid execution status',
  [ErrorCode.EXEC_LOG_FETCH_FAILED]: 'Failed to fetch execution logs',

  // Executor errors
  [ErrorCode.EXECUTOR_NOT_FOUND]: 'Executor not found',
  [ErrorCode.EXECUTOR_UNAVAILABLE]: 'Executor is unavailable',
  [ErrorCode.EXECUTOR_REGISTRATION_FAILED]: 'Executor registration failed',
  [ErrorCode.EXECUTOR_HEARTBEAT_FAILED]: 'Executor heartbeat failed',
  [ErrorCode.EXECUTOR_AT_CAPACITY]: 'Executor is at maximum capacity',

  // User errors
  [ErrorCode.USER_NOT_FOUND]: 'User not found',
  [ErrorCode.USER_ALREADY_EXISTS]: 'User already exists',
  [ErrorCode.USER_INVALID_CREDENTIALS]: 'Invalid user credentials',
  [ErrorCode.USER_PERMISSION_DENIED]: 'Permission denied',

  // Database errors
  [ErrorCode.DB_CONNECTION_FAILED]: 'Database connection failed',
  [ErrorCode.DB_QUERY_FAILED]: 'Database query failed',
  [ErrorCode.DB_TRANSACTION_FAILED]: 'Database transaction failed',
  [ErrorCode.DB_UNIQUE_CONSTRAINT_VIOLATION]: 'Unique constraint violation',

  // Validation errors
  [ErrorCode.VALIDATION_FAILED]: 'Validation failed',
  [ErrorCode.VALIDATION_INVALID_INPUT]: 'Invalid input data',
  [ErrorCode.VALIDATION_MISSING_REQUIRED_FIELD]: 'Missing required field',
  [ErrorCode.VALIDATION_INVALID_FORMAT]: 'Invalid data format',

  // Configuration errors
  [ErrorCode.CONFIG_NOT_FOUND]: 'Configuration not found',
  [ErrorCode.CONFIG_INVALID_VALUE]: 'Invalid configuration value',
  [ErrorCode.CONFIG_LOAD_FAILED]: 'Failed to load configuration',

  // Notification errors
  [ErrorCode.NOTIF_SEND_FAILED]: 'Failed to send notification',
  [ErrorCode.NOTIF_INVALID_CHANNEL]: 'Invalid notification channel',
  [ErrorCode.NOTIF_CONFIGURATION_MISSING]: 'Notification configuration missing',

  // AI service errors
  [ErrorCode.AI_SERVICE_UNAVAILABLE]: 'AI service is unavailable',
  [ErrorCode.AI_ANALYSIS_FAILED]: 'AI analysis failed',
  [ErrorCode.AI_INVALID_RESPONSE]: 'Invalid AI service response',

  // Security errors
  [ErrorCode.SEC_PATH_TRAVERSAL]: 'Path traversal attack detected',
  [ErrorCode.SEC_SQL_INJECTION]: 'SQL injection attack detected',
  [ErrorCode.SEC_XSS_ATTACK]: 'XSS attack detected',
  [ErrorCode.SEC_CSRF_ATTACK]: 'CSRF attack detected',
  [ErrorCode.SEC_RATE_LIMIT_EXCEEDED]: 'Rate limit exceeded',

  // System errors
  [ErrorCode.SYS_INTERNAL_ERROR]: 'Internal system error',
  [ErrorCode.SYS_SERVICE_UNAVAILABLE]: 'Service unavailable',
  [ErrorCode.SYS_TIMEOUT]: 'Operation timed out',
  [ErrorCode.SYS_RESOURCE_EXHAUSTED]: 'System resources exhausted',
};

/**
 * Custom error class with error code support
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: Record<string, any>;

  constructor(
    code: ErrorCode,
    statusCode: number = 500,
    details?: Record<string, any>,
  ) {
    super(ErrorMessages[code]);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.name = 'AppError';

    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, AppError.prototype);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details,
      timestamp: new Date().toISOString(),
    };
  }
}
