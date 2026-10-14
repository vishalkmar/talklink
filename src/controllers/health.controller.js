const { getHealth } = require('../services/health.service');

const health = async (req, res) => {
  const data = await getHealth();
  res.status(data.status === 'ok' ? 200 : 503).json({ success: data.status === 'ok', data });
};

module.exports = { health };
