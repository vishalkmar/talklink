// Force-update gate. The app sends "X-App-Version: 1.2.3" on every request; versions below
// MIN_APP_VERSION get 426 APP_UPDATE_REQUIRED and the app shows the Force Update screen.
// Requests without the header pass (web tools, health checks, webhooks).
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { compareVersions, isValidVersion } = require('../utils/semver');

const isUpdateRequired = (version) =>
  isValidVersion(version) && compareVersions(version, config.minAppVersion) < 0;

const requireSupportedAppVersion = (req, res, next) => {
  const version = req.get('x-app-version');
  if (isUpdateRequired(version)) {
    return next(
      new ApiError(426, 'APP_UPDATE_REQUIRED', 'Please update the app to continue', {
        minAppVersion: config.minAppVersion,
      }),
    );
  }
  return next();
};

module.exports = { requireSupportedAppVersion, isUpdateRequired };
