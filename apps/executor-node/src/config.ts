const adminApiUrl = process.env.ADMIN_API_URL || 'http://admin-api:3105';
const adminApiUrlInternal = process.env.ADMIN_API_URL_INTERNAL || adminApiUrl;
const configuredAdminApiUrls = (process.env.ADMIN_API_URLS || '')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

export const config = {
  appName: process.env.APP_NAME || 'executor-node-1',
  groupName: process.env.GROUP_NAME || process.env.EXECUTOR_GROUP || '',
  port: parseInt(process.env.PORT || '8002', 10),
  executorAddress: process.env.EXECUTOR_ADDRESS || 'executor-node:8002',
  executorAddressPublic: process.env.EXECUTOR_ADDRESS_PUBLIC || process.env.EXECUTOR_ADDRESS || 'executor-node:8002',
  executorId: process.env.EXECUTOR_ID || '',
  adminApiUrl,
  adminApiUrlInternal,
  adminApiUrlExternal: process.env.ADMIN_API_URL_EXTERNAL || '',
  adminApiUrls: configuredAdminApiUrls.length > 0 ? configuredAdminApiUrls : [adminApiUrlInternal],
  workDir: process.env.WORK_DIR || '/tmp/autocodeflow/tasks',
  maxConcurrentTasks: parseInt(process.env.MAX_CONCURRENT_TASKS || '10', 10),
  taskTimeoutSeconds: parseInt(process.env.TASK_TIMEOUT_SECONDS || '300', 10),
  heartbeatIntervalSeconds: parseInt(process.env.HEARTBEAT_INTERVAL_SECONDS || '30', 10),
  logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS || '7', 10),
  npmRegistryUrl: process.env.NPM_REGISTRY_URL || '',  // Private npm registry for task dependencies
  pythonRegistryUrl: process.env.PYTHON_REGISTRY_URL || '',  // Private PyPI registry for task dependencies
  token: process.env.EXECUTOR_SHARED_TOKEN || process.env.EXECUTOR_SECRET || (() => { const i = process.argv.indexOf('--token'); return i !== -1 ? process.argv[i + 1] || '' : ''; })(),
};
