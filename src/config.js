const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

const config = {
  port: num(process.env.PORT, 3333),
  falKey: process.env.FAL_KEY || '',
  falT2V: process.env.FAL_MODEL_T2V || 'minimax/h3-max-turbo/text-to-video',
  falI2V: process.env.FAL_MODEL_I2V || 'minimax/h3-max-turbo/image-to-video',
  resolution: process.env.FAL_RESOLUTION || '480P',
  promptExpansion: process.env.FAL_PROMPT_EXPANSION || 'disabled',
  costPerSecond: num(process.env.COST_PER_SECOND, 0.025),
  sceneSeconds: num(process.env.SCENE_SECONDS, 10),
  wordsPerMinute: num(process.env.WORDS_PER_MINUTE, 140),
  maxScenes: num(process.env.MAX_SCENES, 400),
  openaiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5-mini',
  maxRetries: 3,
  pollIntervalMs: 4000,
  sceneTimeoutMs: 20 * 60 * 1000,
  dataDir: path.join(__dirname, '..', 'data'),
};

module.exports = config;
