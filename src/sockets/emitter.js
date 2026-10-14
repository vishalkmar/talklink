// Holds the Socket.IO server so services can push events without importing sockets/index.js
// (which would create a require cycle: index -> feature socket -> service -> index).
let io = null;

const userRoom = (userId) => `user:${userId}`;

const setIO = (server) => {
  io = server;
};

const getIO = () => io;

// Server -> every device of one user.
const emitToUser = (userId, event, payload) => {
  if (io) io.to(userRoom(userId)).emit(event, payload);
};

// One specific device (WebRTC signaling goes to the device that is in the call).
const emitToSocket = (socketId, event, payload) => {
  if (io) io.to(socketId).emit(event, payload);
};

// Same payload to several users.
const emitToUsers = (userIds, event, payload) => {
  if (io && userIds.length) io.to(userIds.map(userRoom)).emit(event, payload);
};

// Drops every socket of a user (account deleted / suspended / logged out everywhere).
const disconnectUser = (userId) => {
  if (io) io.in(userRoom(userId)).disconnectSockets(true);
};

module.exports = { setIO, getIO, emitToUser, emitToSocket, emitToUsers, disconnectUser, userRoom };
