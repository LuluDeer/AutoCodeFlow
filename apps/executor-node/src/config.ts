export const config = {
  appName: process.env.APP_NAME || 'executor-node-1',
  port: parseInt(process.env.PORT || '8002', 10),
  executorAddress: process.env.EXECUTOR_ADDRESS || 'executor-node:8002',
  executorAddressPublic: process.env.EXECUTOR_ADDRESS_PUBLIC || process.env.EXECUTOR_ADDRESS || 'executor-node:8002',
  adminApiUrl: process.env.ADMIN_API_URL || 'http://admin-api:3001',
  adminApiUrlInternal: process.env.ADMIN_API_URL_INTERNAL || process.env.ADMIN_API_URL || 'http://admin-api:3001',
  adminApiUrlExternal: process.env.ADMIN_API_URL_EXTERNAL || '',
  workDir: process.env.WORK_DIR || '/tmp/autoflow/tasks',
  maxConcurrentTasks: parseInt(process.env.MAX_CONCURRENT_TASKS || '10', 10),
};
