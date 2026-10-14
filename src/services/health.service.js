// Dependency health registry. Connections (Mongo, store, ...) register a status
// function; GET /health reports them all.
const config = require('../config');

const checks = new Map();

const registerCheck = (name, fn) => checks.set(name, fn);

const getHealth = async () => {
  const dependencies = {};
  for (const [name, fn] of checks) {
    try {
      dependencies[name] = await fn();
    } catch {
      dependencies[name] = 'error';
    }
  }
  const ok = Object.values(dependencies).every((s) => s === 'up');
  return {
    status: ok ? 'ok' : 'degraded',
    version: config.appVersion,
    env: config.env,
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    dependencies,
  };
};

module.exports = { registerCheck, getHealth };
