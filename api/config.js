const config = require('./_lib/config');
const { handler, authState } = require('./_lib/http');

// Público (sem segredos): diz ao front se precisa de senha e se as chaves existem.
module.exports = handler(async (_body, req) => {
  const auth = authState(req);
  return {
    authRequired: auth !== 'open',
    authOk: auth === 'ok' || auth === 'open',
    misconfigured: auth === 'misconfigured',
    hasFalKey: !!config.falKey,
    hasTextKey: !!config.openaiKey,
    sceneSeconds: config.sceneSeconds,
    costPerSecond: config.costPerSecond,
    imageT2ICost: config.imageT2ICost,
    imageI2ICost: config.imageI2ICost,
    resolution: config.resolution,
    wordsPerMinute: config.wordsPerMinute,
    maxScenes: config.maxScenes,
  };
}, { method: 'GET', auth: false });
