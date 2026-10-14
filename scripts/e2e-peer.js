// "Other person" for the Maestro E2E flows (Phase 34.2). Needs the dev server (npm run dev) and
// the seeded users (npm run seed). Never runs against production.
//   node scripts/e2e-peer.js [email=meera@test.talklink.app]
// The peer goes online for random matches, accepts every match request after ~1 s, replies to
// chat messages ("Hi from the E2E peer!"), and hangs up audio calls after 8 s (it has no
// microphone - the flow only checks that the call screen opens and can be ended).
const { io } = require('socket.io-client');
const config = require('../src/config');
const { connectDB, disconnectDB } = require('../src/config/db');
const { User } = require('../src/models');
const { signAccessToken } = require('../src/services/token.service');
const E = require('../src/constants/socketEvents.json');

const EMAIL = process.argv[2] || 'meera@test.talklink.app';
const URL = process.env.E2E_URL || `http://localhost:${config.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  if (config.isProd) throw new Error('Refusing to run against production');
  await connectDB();
  const user = await User.findOne({ email: EMAIL });
  if (!user) throw new Error(`${EMAIL} not found - run npm run seed`);
  await disconnectDB();

  const s = io(URL, {
    auth: { token: signAccessToken(user._id) },
    transports: ['websocket'],
  });
  const goOnline = () =>
    s.timeout(5000).emitWithAck(E.PRESENCE_SET, { available: true, foreground: true });

  s.on('connect', async () => {
    await goOnline();
    console.error(`[peer] ${user.name} #${user.privateNumber} online at ${URL}`);
  });
  s.on('connect_error', (err) => console.error('[peer] connect error', err.message));

  s.on(E.MATCH_INCOMING, async ({ requestId, mode }) => {
    await sleep(1000);
    const res = await s.timeout(5000).emitWithAck(E.MATCH_ACCEPT, { requestId });
    console.error(`[peer] accepted ${mode} match`, res && res.ok ? 'ok' : res);
  });

  s.on(E.MATCH_FOUND, async ({ roomId, callId, mode }) => {
    const id = roomId || callId;
    if (mode === 'audio' && id) {
      await sleep(8000);
      await s.timeout(5000).emitWithAck(E.CALL_END, { roomId: id, reason: 'hangup' }).catch(() => {});
      console.error('[peer] hung up');
      await goOnline();
    }
  });

  s.on(E.CHAT_NEW, async ({ message, conversation }) => {
    if (!message || String(message.senderId) === String(user._id)) return;
    await sleep(800);
    await s
      .timeout(5000)
      .emitWithAck(E.CHAT_SEND, {
        conversationId: conversation && conversation.id,
        text: 'Hi from the E2E peer!',
        clientMsgId: `peer-${Date.now()}`,
      })
      .catch(() => {});
  });

  s.on(E.SESSION_ENDED, () => goOnline());
  s.on(E.CALL_ENDED, () => goOnline());

  process.on('SIGINT', () => {
    s.close();
    process.exit(0);
  });
};

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
