// ICE servers for WebRTC (17.12 / 17.13 / 18.12 - 18.14).
// Own coturn with time-limited credentials ("TURN REST API" / use-auth-secret):
//   username   = "<expiry unix seconds>:<userId>"
//   credential = base64( HMAC-SHA1( TURN_SECRET, username ) )
// coturn checks the HMAC with the same static-auth-secret and rejects expired usernames.
// Google STUN is always included as a fallback. Without TURN configured (dev) only STUN is
// returned - calls then work on most networks but not behind strict CGNAT.
const crypto = require('crypto');
const config = require('../config');

const GOOGLE_STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };

const turnCredential = (secret, username) =>
  crypto.createHmac('sha1', secret).update(username).digest('base64');

const getIceServers = (userId, now = Date.now()) => {
  const { host, secret, ttl } = config.turn;
  if (!host || !secret) {
    return { iceServers: [GOOGLE_STUN], ttl: 0, expiresAt: null, turn: false };
  }
  const expiry = Math.floor(now / 1000) + ttl;
  const username = `${expiry}:${userId}`;
  const credential = turnCredential(secret, username);
  return {
    iceServers: [
      { urls: [`stun:${host}:3478`] },
      {
        urls: [
          `turn:${host}:3478?transport=udp`,
          `turn:${host}:3478?transport=tcp`,
          `turns:${host}:5349?transport=tcp`, // TLS on 5349 gets through restrictive networks
        ],
        username,
        credential,
      },
      GOOGLE_STUN,
    ],
    ttl,
    expiresAt: expiry * 1000,
    turn: true,
  };
};

module.exports = { getIceServers, turnCredential, GOOGLE_STUN };
