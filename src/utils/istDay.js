// India Standard Time day helpers (no DST). Daily limits and bonuses reset at IST midnight.
const IST_OFFSET_MS = 330 * 60 * 1000;

// "2026-10-07" for the IST calendar day of `date`
const istDayKey = (date = new Date()) =>
  new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

// the UTC instant of today's IST midnight
const istDayStart = (date = new Date()) => {
  const key = istDayKey(date);
  return new Date(new Date(`${key}T00:00:00.000Z`).getTime() - IST_OFFSET_MS);
};

const istNextDayStart = (date = new Date()) =>
  new Date(istDayStart(date).getTime() + 24 * 3600 * 1000);

// day key `n` days before `date`'s IST day
const istDayKeyOffset = (date = new Date(), n = -1) =>
  istDayKey(new Date(istDayStart(date).getTime() + n * 24 * 3600 * 1000 + 3600 * 1000));

// ISO-8601 week of the IST calendar day, e.g. "2026-W41" (weeks start on Monday)
const istWeekKey = (date = new Date()) => {
  const d = new Date(`${istDayKey(date)}T00:00:00.000Z`);
  const day = d.getUTCDay() || 7; // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday of this week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

// next Monday 00:00 IST
const istNextWeekStart = (date = new Date()) => {
  const start = istDayStart(date);
  const day = new Date(`${istDayKey(date)}T00:00:00.000Z`).getUTCDay() || 7;
  return new Date(start.getTime() + (8 - day) * 24 * 3600 * 1000);
};

module.exports = {
  istDayKey,
  istDayStart,
  istNextDayStart,
  istDayKeyOffset,
  istWeekKey,
  istNextWeekStart,
};
