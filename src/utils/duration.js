// Parses "15m", "30d", "3600" (seconds) etc. into seconds.
const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

const toSeconds = (value) => {
  if (typeof value === 'number') return value;
  const match = /^(\d+)\s*([smhd]?)$/.exec(String(value).trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  return Number(match[1]) * UNITS[match[2] || 's'];
};

module.exports = { toSeconds };
