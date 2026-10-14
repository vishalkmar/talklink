// Dev seed: 5 test users (idempotent - re-running updates them instead of duplicating).
// Usage: npm run seed
const config = require('../src/config');
const { connectDB, disconnectDB } = require('../src/config/db');
const { User } = require('../src/models');
const { generatePrivateNumber } = require('../src/utils/privateNumber');

const USERS = [
  { email: 'aarav@test.talklink.app', name: 'Aarav', gender: 'male', avatar: 'avatar_01' },
  { email: 'diya@test.talklink.app', name: 'Diya', gender: 'female', avatar: 'avatar_02' },
  { email: 'kabir@test.talklink.app', name: 'Kabir', gender: 'male', avatar: 'avatar_03' },
  { email: 'meera@test.talklink.app', name: 'Meera', gender: 'female', avatar: 'avatar_04' },
  { email: 'sam@test.talklink.app', name: 'Sam', gender: 'other', avatar: null },
];

const run = async () => {
  if (config.isProd) throw new Error('Refusing to seed in production');
  await connectDB();
  for (const u of USERS) {
    const existing = await User.findOne({ email: u.email });
    if (existing) {
      Object.assign(existing, u);
      await existing.save();
      console.error(`updated  ${existing.privateNumber}  ${u.email}`);
    } else {
      const created = await User.create({
        ...u,
        privateNumber: await generatePrivateNumber(),
        credits: config.economy.signupBonusCredits,
      });
      console.error(`created  ${created.privateNumber}  ${u.email}`);
    }
  }
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDB());
