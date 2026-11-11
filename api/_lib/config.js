const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

module.exports = {
  falKey: process.env.FAL_KEY || '',
  falT2V: process.env.FAL_MODEL_T2V || 'minimax/h3-max-turbo/text-to-video',
  falI2V: process.env.FAL_MODEL_I2V || 'minimax/h3-max-turbo/image-to-video',
  resolution: process.env.FAL_RESOLUTION || '480P',
  promptExpansion: process.env.FAL_PROMPT_EXPANSION || 'disabled',
  costPerSecond: num(process.env.COST_PER_SECOND, 0.025),
  // Imagens estáticas: texto→imagem (sem referência) e imagem→imagem (mantém personagem/produto/cenário)
  imageT2I: process.env.IMAGE_T2I_MODEL || 'fal-ai/flux-2-flex',
  imageI2I: process.env.IMAGE_I2I_MODEL || 'fal-ai/flux-pro/kontext',
  imageT2ICost: num(process.env.IMAGE_T2I_COST, 0.05),
  imageI2ICost: num(process.env.IMAGE_I2I_COST, 0.04),
  sceneSeconds: num(process.env.SCENE_SECONDS, 10),
  wordsPerMinute: num(process.env.WORDS_PER_MINUTE, 140),
  maxScenes: num(process.env.MAX_SCENES, 400),
  openaiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5-mini',
  appPassword: process.env.APP_PASSWORD || '',
};
