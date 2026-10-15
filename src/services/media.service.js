// Media uploads (Phase 36 voice messages, Phase 37 status) on Cloudinary.
// The API secret never leaves the server: the app asks POST /media/sign for a short-lived signed
// upload (fixed folder per user + kind), uploads the file straight to Cloudinary, then sends back
// the public_id / url it got. We accept only files from our cloud, in that user's folder.
// Deleting (view-once opened, status expired) goes through the Cloudinary Admin "destroy" API.
const crypto = require('crypto');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const settings = { ...config.cloudinary };

// kind -> where it goes and what Cloudinary calls it (audio and video are "video" resources)
const KINDS = {
  chat_audio: { folder: 'talklink/chat-audio', resourceType: 'video', maxBytes: 5 * 1024 * 1024 },
  status_image: { folder: 'talklink/status', resourceType: 'image', maxBytes: 10 * 1024 * 1024 },
  status_video: { folder: 'talklink/status', resourceType: 'video', maxBytes: 30 * 1024 * 1024 },
};

const isConfigured = () => Boolean(settings.cloudName && settings.apiKey && settings.apiSecret);

const assertConfigured = () => {
  if (!isConfigured()) {
    throw new ApiError(503, 'MEDIA_UNAVAILABLE', 'Media uploads are not set up yet');
  }
};

// Cloudinary signature: sha1("k1=v1&k2=v2..." sorted by key + api_secret)
const sign = (params) => {
  const base = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(`${base}${settings.apiSecret}`).digest('hex');
};

const folderFor = (kind, userId) => `${KINDS[kind].folder}/${userId}`;

// POST /media/sign -> what the app needs for one upload (valid ~1 hour on Cloudinary's side)
const signUpload = (userId, kind) => {
  assertConfigured();
  const k = KINDS[kind];
  if (!k) throw ApiError.badRequest('Unknown media kind', 'VALIDATION_ERROR');
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { folder: folderFor(kind, String(userId)), timestamp };
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${settings.cloudName}/${k.resourceType}/upload`,
    apiKey: settings.apiKey,
    timestamp,
    folder: params.folder,
    signature: sign(params),
    resourceType: k.resourceType,
    maxBytes: k.maxBytes,
  };
};

// The app hands us what Cloudinary returned; trust it only if it is ours and in the user's folder.
const verifyUpload = (userId, kind, { publicId, url }) => {
  assertConfigured();
  const k = KINDS[kind];
  const folder = `${folderFor(kind, String(userId))}/`;
  const host = `https://res.cloudinary.com/${settings.cloudName}/${k.resourceType}/upload/`;
  if (
    typeof publicId !== 'string' ||
    typeof url !== 'string' ||
    !publicId.startsWith(folder) ||
    publicId.includes('..') ||
    !url.startsWith(host) ||
    !url.includes(publicId)
  ) {
    throw ApiError.badRequest('Upload not recognised', 'INVALID_MEDIA');
  }
  return { publicId, url, resourceType: k.resourceType };
};

// default transport = fetch; tests replace it
let transport = async (endpoint, form) => {
  const res = await fetch(endpoint, {
    method: 'POST',
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

// best effort: a file that can't be deleted now is retried by the purge job later
const destroy = async (publicId, resourceType = 'video') => {
  if (!isConfigured() || !publicId) return false;
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { public_id: publicId, timestamp, invalidate: 'true' };
  try {
    const { status, data } = await transport(
      `https://api.cloudinary.com/v1_1/${settings.cloudName}/${resourceType}/destroy`,
      { ...params, api_key: settings.apiKey, signature: sign(params) },
    );
    // "not found" means it is already gone - fine
    const ok = status < 400 && (data.result === 'ok' || data.result === 'not found');
    if (!ok) logger.warn({ publicId, status, result: data.result }, 'Cloudinary destroy failed');
    return ok;
  } catch (err) {
    logger.warn({ publicId, err: err.message }, 'Cloudinary destroy failed');
    return false;
  }
};

const __setTransportForTests = (fn) => {
  transport = fn;
};

module.exports = {
  settings,
  KINDS,
  isConfigured,
  sign,
  signUpload,
  verifyUpload,
  destroy,
  __setTransportForTests,
};
