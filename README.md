# Flow Video Creator AI (versão local)

Transforma roteiros longos (5 min a 1 h+) em dezenas/centenas de clipes de 10 s gerados pelo
**MiniMax H3 Max Turbo** no fal.ai (480P, sem áudio) e salva cada clipe na sua pasta:
`01_cena.mp4`, `02_cena.mp4`, … Não monta o vídeo final e não usa banco de dados — o progresso fica em
`project_state.json` dentro da pasta de destino.

## Como rodar

Requisitos: Node.js 18.17+ (testado no 24).

```bash
npm install
copy .env.example .env      # depois preencha FAL_KEY e OPENAI_API_KEY
npm start
```

Abra http://localhost:3333.

## Fluxo

1. **Pasta de destino** — digite o caminho ou clique em *Escolher…* (abre o seletor de pastas do Windows).
2. **Imagem de referência** (opcional; obrigatória no modo *Apenas imagem*) com o modo de uso.
3. **Roteiro** — dividido de forma determinística em blocos de ~10 s (`WORDS_PER_MINUTE`=140 → ~23 palavras
   por cena; ~1.450 palavras ≈ 62 cenas). A IA de texto escreve o prompt visual de cada bloco.
4. **Configurações** — duração (automática ou fixa), 16:9 / 9:16, estilo e continuidade.
5. **Orçamento** — cenas, duração, custo por cena e total. Os prompts podem ser revisados/editados.
   O botão **GERAR VÍDEO COMPLETO** só libera após marcar a confirmação.
6. **Geração** — sequencial, com 3 tentativas automáticas por cena, barra de progresso e Pausar / Continuar /
   Cancelar. Pausar termina a cena atual e para.

### Continuidade
Com a opção ligada, cada cena (a partir da 2ª) usa o **último quadro da cena anterior** como `image_url`
(endpoint image-to-video). A 1ª cena usa a imagem de referência (exceto no modo *Referência visual geral*).
Nos modos Personagem/Produto/Cenário, a descrição da referência também é injetada em todos os prompts.
O quadro é extraído com o ffmpeg embutido (`ffmpeg-static`) e fica em `_frames/`.

### Retomada
Se o app for fechado no meio (ex.: cena 15 de 60), ao abrir de novo ele carrega o último projeto e mostra
um aviso para retomar. Cenas já baixadas não são refeitas; um job já enviado ao fal.ai é reconsultado em vez
de pago de novo. Também é possível clicar em *Abrir projeto* para carregar o `project_state.json` de qualquer pasta.

## Estrutura

```
server.js               Express + rotas + SSE (progresso em tempo real)
src/config.js           variáveis do .env
src/planner.js          divide roteiro, chama a IA, compõe prompts, calcula orçamento
src/runner.js           fila sequencial: submit → poll → download → último quadro → salva estado
src/services/fal.js     fila do fal.ai (queue.fal.run) e download binário
src/services/llm.js     OpenAI: descrição da referência, bíblia visual, prompts das cenas, modo só-imagem
src/services/splitter.js divisão determinística do roteiro
src/services/styles.js  estilos e modificadores injetados
src/services/media.js   ffmpeg: recorte da referência e último quadro
public/                 interface (HTML + Tailwind + JS)
```

## Custos
O preço vem de `COST_PER_SECOND` no `.env`. Tabela do fal.ai para o H3 Max Turbo 480P:
US$ 0,025/s (US$ 0,25 por cena de 10 s) a partir de 16/11/2026; promoção de 1 a 15/11/2026 a US$ 0,0175/s.
Confira o valor atual em https://fal.ai/models/minimax/h3-max-turbo/text-to-video e ajuste se necessário.
