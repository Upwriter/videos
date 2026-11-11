const crypto = require('crypto');
const config = require('./config');

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

// Protege as chaves: sem APP_PASSWORD, só funciona fora da Vercel (uso local).
function authState(req) {
  const pw = config.appPassword;
  if (!pw) return process.env.VERCEL ? 'misconfigured' : 'open';
  const got = Buffer.from(String(req.headers['x-app-password'] || ''));
  const want = Buffer.from(pw);
  return got.length === want.length && crypto.timingSafeEqual(got, want) ? 'ok' : 'denied';
}

function checkAuth(req) {
  const st = authState(req);
  if (st === 'misconfigured') throw httpError(500, 'Defina APP_PASSWORD nas variáveis de ambiente da Vercel.');
  if (st === 'denied') throw httpError(401, 'Senha incorreta.');
}

/** Envolve um handler: valida método e senha, devolve JSON e erros padronizados. */
function handler(fn, { method = 'POST', auth = true } = {}) {
  return async (req, res) => {
    try {
      if (req.method !== method) throw httpError(405, 'Método não permitido');
      if (auth) checkAuth(req);
      let body = req.body;
      if (typeof body === 'string') body = body ? JSON.parse(body) : {};
      const out = await fn(body || {}, req);
      res.status(200).json(out ?? { ok: true });
    } catch (e) {
      const status = e.status || 500;
      res.status(status).json({ error: e.message || 'Erro interno', ...(e.jobFailed ? { jobFailed: true } : {}) });
    }
  };
}

module.exports = { handler, httpError, authState };
