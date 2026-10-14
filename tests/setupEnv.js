// Test env - set before src/config loads (dotenv never overrides existing vars).
process.env.NODE_ENV = 'test';
process.env.MONGO_URI =
  process.env.TEST_MONGO_URI ||
  'mongodb://127.0.0.1:27017/talklink_test?replicaSet=rs0&directConnection=true';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6380/15';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret-0000';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret-000';
process.env.DEV_OTP_BYPASS = 'false';
process.env.LOG_LEVEL = 'silent';
