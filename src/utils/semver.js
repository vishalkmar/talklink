// Minimal "x.y.z" comparison (no pre-release tags - app versions are plain).
const parse = (v) =>
  String(v || '0.0.0')
    .split('.')
    .slice(0, 3)
    .map((n) => parseInt(n, 10) || 0);

// -1 if a < b, 0 if equal, 1 if a > b
const compareVersions = (a, b) => {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
};

const isValidVersion = (v) => /^\d+\.\d+\.\d+$/.test(String(v || ''));

module.exports = { compareVersions, isValidVersion };
