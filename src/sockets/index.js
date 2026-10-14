// Socket.IO server (Phase 13): authenticated, one room per user (single instance, ADR-041).
// Feature modules (presence, match, call, chat) register their handlers in `modules` below.
const { Server } = require('socket.io');
const config = require('../config');
const logger = require('../utils/logger');
const socketAuth = require('./auth');
const registry = require('./registry');
const { rateLimitMiddleware } = require('./helpers');
const emitter = require('./emitter');

const presence = require('../services/presence.service');
const match = require('../services/match.service');
const callSession = require('../services/callSession.service');
const ringing = require('../services/ringing.service');
const sessions = require('../services/session.service');

const modules = [
  require('./system.socket'),
  require('./presence.socket'),
  require('./match.socket'),
  require('./call.socket'),
  require('./chat.socket'),
  require('./session.socket'),
];

let io = null;

const initSockets = (httpServer) => {
  io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: (origin, cb) =>
        cb(null, !origin || !config.isProd || config.corsOrigins.includes(origin)),
      credentials: true,
    },
    // 13.14 heartbeat: a dead connection is dropped after ~pingInterval + pingTimeout (35 s).
    pingInterval: 20000,
    pingTimeout: 15000,
    maxHttpBufferSize: 100 * 1024, // signaling / chat messages are small
    serveClient: false,
  });

  emitter.setIO(io);

  io.use(socketAuth);

  io.on('connection', async (socket) => {
    const { userId } = socket.data;
    socket.join(emitter.userRoom(userId)); // 13.4
    socket.use(rateLimitMiddleware(socket));
    modules.forEach((register) => register(io, socket));

    // Registered before any await so a very fast disconnect is never missed.
    const added = registry.addSocket(userId, socket.id).catch((err) => {
      logger.error({ err, userId }, 'Socket registry add failed');
    }); // 13.5
    socket.on('disconnect', async (reason) => {
      await added; // never remove before the add finished
      let remaining = null;
      try {
        remaining = await registry.removeSocket(userId, socket.id);
      } catch (err) {
        logger.error({ err, userId }, 'Socket registry remove failed');
      }
      logger.info({ userId, socketId: socket.id, reason, remaining }, 'Socket disconnected'); // 13.15
      if (remaining !== null) presence.onDisconnect(userId, remaining); // 14.4 offline after grace
      if (remaining === 0) {
        match
          .onUserGone(userId)
          .catch((err) => logger.error({ err, userId }, 'match cleanup failed'));
        callSession
          .onUserGone(userId) // 17.9 peer-lost grace
          .catch((err) => logger.error({ err, userId }, 'call peer-lost failed'));
        sessions
          .onUserGone(userId) // 25.14 60 s to come back to a text session
          .catch((err) => logger.error({ err, userId }, 'session grace failed'));
      }
    });

    await added;
    callSession
      .onUserBack(userId)
      .catch((err) => logger.error({ err, userId }, 'call resume failed'));
    sessions.onUserBack(userId);
    ringing
      .resendPending(userId, socket.id) // 21.9 app opened from the incoming-call push
      .catch((err) => logger.error({ err, userId }, 'ring resend failed'));
    logger.info(
      { userId, socketId: socket.id, transport: socket.conn.transport.name },
      'Socket connected',
    );
  });

  return io;
};

const closeSockets = () =>
  new Promise((resolve) => {
    if (!io) return resolve();
    return io.close(() => {
      emitter.setIO(null);
      resolve();
    });
  });

module.exports = {
  initSockets,
  closeSockets,
  getIO: emitter.getIO,
  emitToUser: emitter.emitToUser,
  emitToUsers: emitter.emitToUsers,
  disconnectUser: emitter.disconnectUser,
  userRoom: emitter.userRoom,
};
