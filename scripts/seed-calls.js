// Dev seed: N call-history entries between the seed users (Phase 12.19 scroll test).
// Usage: npm run seed            (creates the 5 test users first)
//        npm run seed:calls       (100 calls)   or   node scripts/seed-calls.js 300
const config = require('../src/config');
const { connectDB, disconnectDB } = require('../src/config/db');
const { User, Call } = require('../src/models');

const COUNT = Number(process.argv[2]) || 100;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const run = async () => {
  if (config.isProd) throw new Error('Refusing to seed in production');
  await connectDB();
  const users = await User.find({ email: /@test\.talklink\.app$/ });
  if (users.length < 2) throw new Error('Run `npm run seed` first (needs the test users)');

  const now = Date.now();
  const docs = [];
  for (let i = 0; i < COUNT; i += 1) {
    const [caller, callee] = [...users].sort(() => Math.random() - 0.5);
    const status = pick(['ended', 'ended', 'ended', 'ended', 'missed', 'declined']);
    const durationSec = status === 'ended' ? 20 + Math.floor(Math.random() * 1800) : 0;
    const createdAt = new Date(now - Math.floor(Math.random() * 60 * 24 * 3600 * 1000)); // 60 days
    const startedAt = status === 'ended' ? createdAt : undefined;
    docs.push({
      callerId: caller._id,
      calleeId: callee._id,
      mode: Math.random() < 0.8 ? 'audio' : 'text',
      matchType: Math.random() < 0.7 ? 'random' : 'direct',
      status,
      startedAt,
      endedAt: startedAt ? new Date(createdAt.getTime() + durationSec * 1000) : undefined,
      durationSec,
      endReason: status === 'ended' ? 'hangup' : status,
      auraEarned: Math.floor(durationSec / 60),
      createdAt,
      updatedAt: createdAt,
    });
  }
  await Call.insertMany(docs, { timestamps: false });
  console.error(`Inserted ${docs.length} calls between ${users.length} test users`);
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDB());
