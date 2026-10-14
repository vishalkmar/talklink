// Chat text clean-up (Phase 23.5 / 23.17). The app renders plain text only (no HTML / markdown),
// so "dangerous content" here means invisible characters used for spoofing / spam and
// abusive words. Links are allowed in private chats and blocked in random sessions.
const { SUBSTRING, WORD, normalise } = require('./nameFilter');

const MAX_LENGTH = 1000;

// control chars (except tab / newline), zero-width + bidi override characters - matching control
// characters is the whole point here
/* eslint-disable no-control-regex */
const INVISIBLE = new RegExp(
  '[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]',
  'g',
);
/* eslint-enable no-control-regex */

const sanitizeText = (text) =>
  String(text === null || text === undefined ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(/\n{4,}/g, '\n\n\n') // no walls of empty lines
    .trim();

const LINK =
  /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|in|net|org|io|me|xyz|link|ly|app|co)\b(\/\S*)?/i;
const hasLink = (text) => LINK.test(text);

// Masks abusive words, keeping the first letter: "fuck you" -> "f*** you".
const maskProfanity = (text) =>
  text.replace(/[\p{L}\p{N}@$!]+/gu, (token) => {
    const n = normalise(token).replace(/[^a-z]/g, '');
    if (!n) return token;
    const bad = WORD.includes(n) || SUBSTRING.some((w) => n.includes(w));
    return bad ? token[0] + '*'.repeat(Math.max(token.length - 1, 1)) : token;
  });

module.exports = { MAX_LENGTH, sanitizeText, hasLink, maskProfanity };
