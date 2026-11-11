# Meus vídeos

Transforma roteiros longos (5 min a 1 h+) em dezenas/centenas de clipes de 10 s gerados pelo
**MiniMax H3 Max Turbo** no fal.ai (480P, sem áudio) e grava cada clipe numa pasta do seu computador:
`01_cena.mp4`, `02_cena.mp4`, … Não monta o vídeo final e não usa banco de dados.

## Como funciona (Vercel)

- **Navegador** — divide o roteiro, comanda a geração cena a cena, baixa cada MP4 direto do CDN do fal.ai
  e grava na pasta escolhida (File System Access API — **Chrome ou Edge no computador**). O progresso fica
  no navegador (IndexedDB) e em `project_state.json` dentro da pasta.
- **Servidor (funções em `/api`)** — só guarda as chaves e repassa as chamadas: `api/ai.js` (OpenAI),
  `api/fal.js` (fila do fal.ai), `api/config.js`. Tudo protegido pela senha `APP_PASSWORD`.

> A aba precisa ficar aberta durante a geração. Se fechar, é só abrir de novo e clicar em **Continuar**:
> cenas prontas não são refeitas e um job já enviado ao fal.ai é reconsultado (não é pago de novo).
> Em outro navegador/PC, use **Abrir projeto de uma pasta** apontando para a pasta com o `project_state.json`.

## Deploy na Vercel

1. Importe o repositório `Upwriter/videos` na Vercel (Framework Preset: **Other**; sem build command).
2. Em *Settings → Environment Variables*, cadastre no mínimo `APP_PASSWORD`, `FAL_KEY` e `OPENAI_API_KEY`
   (veja `.env.example` para as opcionais).
3. Faça o deploy e acesse a URL. A senha é pedida uma vez por navegador.

`vercel.json` já define `public/` como saída estática e 60 s de limite para as funções.

## Rodar localmente

```bash
npm install
copy .env.example .env      # preencha FAL_KEY e OPENAI_API_KEY (APP_PASSWORD é opcional localmente)
npm start
```

Abra http://localhost:3333 no Chrome ou Edge.

## Fluxo

1. **Pasta de destino** — *Escolher pasta…* (o navegador pede permissão para editar).
2. **Imagem de referência** (opcional; obrigatória no modo *Apenas imagem*) com o modo de uso.
3. **Roteiro** — divisão determinística em blocos de ~10 s (140 palavras/min → ~23 palavras por cena;
   ~1.450 palavras ≈ 62 cenas). A IA escreve o prompt visual de cada bloco.
4. **Configurações** — duração (automática ou fixa), 16:9 / 9:16, estilo e continuidade.
5. **Orçamento** — cenas, duração, custo por cena e total; prompts editáveis. **GERAR VÍDEO COMPLETO**
   só libera após confirmar.
6. **Geração** — sequencial, 3 tentativas automáticas por cena, Pausar / Continuar / Cancelar.

**Continuidade:** cada cena (a partir da 2ª) começa no último quadro da anterior (extraído no navegador).
A 1ª usa a imagem de referência (exceto no modo *Referência visual geral*). Nos modos Personagem/Produto/
Cenário a descrição da referência também entra em todos os prompts.

## Estrutura

```
api/config.js  api/ai.js  api/fal.js   funções serverless (proxy com senha)
api/_lib/                              config, auth, cliente fal.ai e OpenAI
public/index.html                      interface
public/js/app.js                       UI
public/js/project.js                   planejamento + persistência
public/js/runner.js                    geração sequencial, retomada
public/js/splitter.js | styles.js | media.js | storage.js | api.js
dev-server.js                          servidor só para uso local
```

## Custos
`COST_PER_SECOND` (padrão US$ 0,025/s = US$ 0,25 por cena de 10 s em 480P, tabela do fal.ai a partir de
16/11/2026). Confira em https://fal.ai/models/minimax/h3-max-turbo/text-to-video.
