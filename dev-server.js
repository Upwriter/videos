// Servidor só para desenvolvimento local (na Vercel, /api/*.js viram funções e /public é estático).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');

const app = express();
app.use(express.json({ limit: '5mb' })); // mesmo limite aproximado da Vercel (4,5 MB)
app.all('/api/config', require('./api/config'));
app.all('/api/ai', require('./api/ai'));
app.all('/api/fal', require('./api/fal'));
app.use(express.static(path.join(__dirname, 'public')));

const port = Number(process.env.PORT) || 3333;
app.listen(port, '127.0.0.1', () => console.log(`\n  Meus vídeos rodando em http://localhost:${port}\n`));
