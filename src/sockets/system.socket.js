// system:ping - acknowledged round-trip check (lets the app measure latency / verify the link).
const EVENTS = require('../constants/socketEvents.json');
const { withAck } = require('./helpers');

module.exports = (io, socket) => {
  socket.on(
    EVENTS.SYSTEM_PING,
    withAck(async () => ({ serverTime: Date.now(), userId: socket.data.userId })),
  );
};
