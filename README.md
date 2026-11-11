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

1. Importe o repositório `Upwriter/videos` na Vercel (Framework Preset: **Other** — o `vercel.json` já força isso).
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

**Apenas gerar prompts:** marque a opção antes de analisar. O app faz a mesma divisão e escreve os mesmos
prompts, mas para aí — nada é enviado ao fal.ai. Os prompts aparecem na tela (copiar um a um ou todos) e
podem ser baixados em TXT, CSV (abre no Excel) e JSON; se houver pasta escolhida, também são salvos nela.
A pasta é opcional nesse modo. Depois, *Quero gerar os vídeos destes prompts* reaproveita o projeto.

**Tipo de mídia:** *Tudo em vídeo*, *Misto* (porcentagem de vídeo ajustável, padrão 10% — o resto vira
imagem estática, distribuído de forma uniforme e com a cena 1 sempre em vídeo) ou *Tudo em imagem*.
Imagens usam FLUX 2 Flex (US$ 0,05) ou, com referência de personagem/produto/cenário, FLUX Kontext
(US$ 0,04). No editor de cenas dá para trocar cada cena entre vídeo e imagem; o total é recalculado e a
confirmação do orçamento é pedida de novo. Imagens são salvas como `NN_cena.jpg` (ocupam o tempo da cena
na edição). Com continuidade, um vídeo que vem depois de uma imagem começa nela.

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
public/js/splitter.js | styles.js | media.js | storage.js | api.js | exports.js
dev-server.js                          servidor só para uso local
```

## Custos
| Mídia | Modelo | Custo por cena |
|---|---|---|
| Vídeo 480P, 10 s, sem áudio | MiniMax H3 Max Turbo (o mais barato dos vídeos do fal.ai comparados) | US$ 0,25 (`COST_PER_SECOND`=0.025) |
| Imagem sem referência | FLUX 2 Flex | US$ 0,05 (`IMAGE_T2I_COST`) |
| Imagem com referência | FLUX Kontext Pro | US$ 0,04 (`IMAGE_I2I_COST`) |

Exemplo, 60 cenas: tudo em vídeo ≈ US$ 15,00 · misto 10% ≈ US$ 4,20 · tudo em imagem ≈ US$ 3,00.
Preços do fal.ai em 11/11/2026 (o vídeo tem promoção até 15/11). Confira nas páginas dos modelos.
