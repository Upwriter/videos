export const STYLES = {
  webcomic: {
    label: 'Webcomic / Stick Figure',
    modifier:
      'A 2D minimalist stick figure character with a white head and black stroke outlines, expressive cartoon eyes, composited inside a detailed digital illustration environment, cinematic moody lighting, clean dark ink outlines, high contrast between the simple character and the richly detailed background, webcomic style, {ASPECT}.',
  },
  forense: {
    label: 'Reconstrução 3D / Forense',
    modifier:
      '3D isometric architectural cross-section render, clean minimal matte gray and white environment, smooth clay-like smooth figures with distinct color coding, studio soft lighting, clean geometry, minimalist technical illustration style, high-end 3D animation look.',
  },
  caricatura: {
    label: 'Caricatura Cartoon (estilo thumbnail)',
    modifier:
      'Bold 2D cartoon caricature illustration, exaggerated expressive characters with oversized heads and strong facial expressions, thick clean black outlines, flat vibrant saturated colors with simple cel shading, bright clean sky-blue background, playful vector comic art style, high contrast, editorial cartoon look, YouTube thumbnail illustration aesthetic, {ASPECT}.',
  },
  realista: { label: 'Realista', modifier: 'Photorealistic footage, natural lighting, realistic textures and skin, true-to-life colors, sharp focus.' },
  cinematografico: {
    label: 'Cinematográfico',
    modifier: 'Cinematic film look, anamorphic lens, shallow depth of field, dramatic lighting, rich color grading, smooth camera movement, 35mm film grain.',
  },
  ugc: {
    label: 'UGC',
    modifier: 'User-generated content style, handheld smartphone footage, authentic casual setting, natural daylight, slight camera shake, social media vibe.',
  },
  publicitario: {
    label: 'Publicitário',
    modifier: 'High-end commercial advertising look, polished studio lighting, crisp product focus, clean background, premium color grading, smooth dolly shots.',
  },
  lifestyle: {
    label: 'Lifestyle',
    modifier: 'Lifestyle video, warm golden-hour light, airy bright tones, candid natural moments, aspirational everyday setting, soft focus background.',
  },
  documentario: {
    label: 'Documentário',
    modifier: 'Documentary footage style, observational camera, natural available light, realistic environments, subtle handheld movement, journalistic tone.',
  },
  personalizado: { label: 'Personalizado', modifier: '' },
};

export function styleModifier(style, format, custom) {
  if (style === 'personalizado') return (custom || '').trim();
  return (STYLES[style] || STYLES.cinematografico).modifier.replace('{ASPECT}', format || '16:9');
}

const REF_LABEL = { personagem: 'main character', produto: 'product', cenario: 'setting' };
const MAX_PROMPT = 1900;

export function composePrompt(prompt, s) {
  const parts = [String(prompt).trim()];
  if (s.reference?.description && REF_LABEL[s.settings.refMode]) {
    parts.push(`Consistent ${REF_LABEL[s.settings.refMode]}: ${s.reference.description}`);
  }
  const mod = styleModifier(s.settings.style, s.settings.format, s.settings.customStyle);
  if (mod) parts.push(`Style: ${mod}`);
  const out = parts.join(' ');
  if (out.length <= MAX_PROMPT) return out;
  const tail = parts.slice(1).join(' '); // corta a cena, nunca o estilo
  return `${parts[0].slice(0, Math.max(200, MAX_PROMPT - tail.length - 2))} ${tail}`;
}
