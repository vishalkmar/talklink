#!/usr/bin/env node
// Phase 34.3: fail if anything secret is committed to git (backend repo).
//  2. no file tracked by git may contain a real-looking key (Brevo, Cashfree, Google, private keys)
//  3. .env files and keystores must not be tracked
// Usage: node scripts/check-secrets.js   (exit code 1 = problem found)
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..'); // git ls-files lists this folder's files


// real key shapes (placeholders in docs use XXXX and are not matched)
const KEY_PATTERNS = [
  { name: 'Brevo API key', re: /xkeysib-[a-f0-9]{40,}/i },
  { name: 'Cashfree secret', re: /cfsk_ma_(?:prod|test)_[A-Za-z0-9_]{20,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'MongoDB URI with password', re: /mongodb(?:\+srv)?:\/\/[^\s:/@]+:[^\s@/]{6,}@/ },
  { name: 'Slack / GitHub token', re: /(?:xox[baprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{36})/ },
];

const FORBIDDEN_FILES = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$)[^/]+$/,
  /\.(jks|keystore|p12|pem)$/,
  /google-services\.json$/,
  /service-account.*\.json$/i,
];

const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const problems = [];
const TEXT = /\.(js|jsx|json|md|yml|yaml|env|example|gradle|properties|xml|sh|conf|template|txt|kt|java)$/i;

const ALLOWED = new Set();

for (const file of tracked) {
  if (!ALLOWED.has(file) && FORBIDDEN_FILES.some((re) => re.test(file))) {
    problems.push(`${file}: must not be committed`);
    continue;
  }
  if (!TEXT.test(file) || file.endsWith('package-lock.json')) continue;
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');
  for (const { name, re } of KEY_PATTERNS) {
    if (re.test(text)) problems.push(`${file}: looks like a ${name}`);
  }
}

if (problems.length) {
  console.error(`Secret check failed (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
process.stdout.write(`Secret check OK (${tracked.length} tracked files).
`);
