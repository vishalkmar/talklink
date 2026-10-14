// Matchmaking load test (Phase 15.18). Needs the dev server running (npm run dev).
//   node scripts/loadtest-match.js [clients=200] [callers=20]
// Creates temporary users, connects them over Socket.IO, marks them available, lets `callers` of
// them request random matches while the rest accept after a human-like delay, then reports:
// time-to-match percentiles, outcomes, and safety checks (nobody matched twice, one winner per
// request). Temporary users and calls are deleted at the end.
const { io } = require('socket.io-client');
const config = require('../src/config');
const { connectDB, disconnectDB } = require('../src/config/db');
const { User, Call } = require('../src/models');
const { generatePrivateNumber } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const EVENTS = require('../src/constants/socketEvents.json');

const CLIENTS = Number(process.argv[2]) || 200;
const CALLERS = Number(process.argv[3]) || 20;
const URL = process.env.LOADTEST_URL || `http://localhost:${config.port}`;
const EMAIL = (i) => `load${i}@loadtest.talklink.app`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];

const run = async () => {
  if (config.isProd) throw new Error('Refusing to run against production');
  await connectDB();
  await User.deleteMany({ email: /@loadtest\.talklink\.app$/ });

  // 1. users
  const users = [];
  const usedNumbers = new Set(); // generatePrivateNumber() checks the DB, not this batch
  for (let i = 0; i < CLIENTS; i += 1) {
    let privateNumber = await generatePrivateNumber();
    while (usedNumbers.has(privateNumber)) privateNumber = await generatePrivateNumber();
    usedNumbers.add(privateNumber);
    users.push({
      email: EMAIL(i),
      name: `Load ${i}`,
      gender: i % 2 ? 'female' : 'male',
      privateNumber,
    });
  }
  const docs = await User.insertMany(users);
  console.error(`created ${docs.length} users`);

  // 2. connect + available
  const t0 = Date.now();
  const sockets = await Promise.all(
    docs.map(
      (u) =>
        new Promise((resolve, reject) => {
          const s = io(URL, {
            auth: { token: signAccessToken(u._id) },
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
          });
          s.uid = String(u._id);
          s.on('connect', () => resolve(s));
          s.on('connect_error', reject);
        }),
    ),
  );
  await Promise.all(
    sockets.map((s) =>
      s.timeout(5000).emitWithAck(EVENTS.PRESENCE_SET, { available: true, foreground: true }),
    ),
  );
  console.error(`connected + available: ${sockets.length} in ${Date.now() - t0} ms`);

  const callers = sockets.slice(0, CALLERS);
  const candidates = sockets.slice(CALLERS);
  const matchedUsers = new Map(); // uid -> count
  const winnersByRequest = new Map();
  const outcomes = { found: 0, timeout: 0, error: 0 };
  const latencies = [];
  const acceptErrors = {};

  // candidates accept after 200-1500 ms (like a human tapping Accept)
  candidates.forEach((s) => {
    s.on(EVENTS.MATCH_INCOMING, async ({ requestId }) => {
      await sleep(200 + Math.random() * 1300);
      const res = await s
        .timeout(5000)
        .emitWithAck(EVENTS.MATCH_ACCEPT, { requestId })
        .catch(() => ({ ok: false, code: 'ACK_TIMEOUT' }));
      if (res.ok) {
        winnersByRequest.set(requestId, (winnersByRequest.get(requestId) || 0) + 1);
        matchedUsers.set(s.uid, (matchedUsers.get(s.uid) || 0) + 1);
      } else {
        acceptErrors[res.code] = (acceptErrors[res.code] || 0) + 1;
      }
    });
  });

  // 3. callers request at the same moment
  await Promise.all(
    callers.map(
      (s) =>
        new Promise((resolve) => {
          const started = Date.now();
          s.once(EVENTS.MATCH_FOUND, () => {
            outcomes.found += 1;
            latencies.push(Date.now() - started);
            matchedUsers.set(s.uid, (matchedUsers.get(s.uid) || 0) + 1);
            resolve();
          });
          s.once(EVENTS.MATCH_TIMEOUT, () => {
            outcomes.timeout += 1;
            resolve();
          });
          s.timeout(5000)
            .emitWithAck(EVENTS.MATCH_REQUEST, { mode: 'audio', connectWith: 'anyone' })
            .then((r) => {
              if (!r.ok) {
                outcomes.error += 1;
                resolve();
              }
            });
        }),
    ),
  );
  await sleep(500);

  // 4. report
  latencies.sort((a, b) => a - b);
  const doubleMatched = [...matchedUsers.values()].filter((n) => n > 1).length;
  const doubleWinners = [...winnersByRequest.values()].filter((n) => n > 1).length;
  const report = {
    clients: CLIENTS,
    callers: CALLERS,
    outcomes,
    timeToMatchMs: latencies.length
      ? { p50: pct(latencies, 50), p90: pct(latencies, 90), max: latencies[latencies.length - 1] }
      : null,
    acceptRejections: acceptErrors,
    safety: { usersMatchedTwice: doubleMatched, requestsWithTwoWinners: doubleWinners },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}
`);

  // 5. cleanup
  sockets.forEach((s) => s.disconnect());
  const ids = docs.map((d) => d._id);
  await Call.deleteMany({ $or: [{ callerId: { $in: ids } }, { calleeId: { $in: ids } }] });
  await User.deleteMany({ _id: { $in: ids } });
  if (doubleMatched || doubleWinners) process.exitCode = 2;
};

run()
  .catch(async (err) => {
    console.error(err.message || err);
    process.exitCode = 1;
    await User.deleteMany({ email: /@loadtest\.talklink\.app$/ }).catch(() => {});
  })
  .finally(() => disconnectDB());
