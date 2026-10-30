# HustleQ Social Data API

Social Data API da HustleQ Beta.

## Stack

- Node.js 22+
- TypeScript
- Fastify
- Zod
- Prisma
- PostgreSQL / Supabase
- Swagger / OpenAPI
- Vitest
- ESLint
- Prettier

## Desenvolvimento

```bash
npm install
cp .env.example .env
npm run dev
```

API local: http://localhost:3000

Documentação: http://localhost:3000/docs

Health check: http://localhost:3000/api/v1/health

## Busca de tendências do Instagram

`POST /api/v1/instagram/trends/search`

```json
{
  "keywords": ["Guaratiba", "Recreio"],
  "minLikes": 200,
  "postType": "reel",
  "searchLimit": 10,
  "daysBack": 30
}
```

Usa `seemuapps/instagram-keyword-posts-scraper`, com `keywords`,
`maxPostsPerKeyword: searchLimit`, `postType` e `minLikes` e `dateFrom: "30 days"`
(ou o período informado em `daysBack`). O alvo é uma string não vazia,
`searchLimit` aceita 1 a 250 (padrão 10) e `daysBack` aceita 1 a 30 (padrão 30).
O Actor pode retornar fotos, reels, vídeos e carrosséis, em ordem de relevância.

A resposta mantém `response.target`, `response.collectedAt`, `response.daysBack`
e `response.posts`. O service traduz os campos do Seemu para autor, mídia,
métricas e localização; imagens de carrosséis ficam em `media.images`.
Métricas desconhecidas ficam como `null`. Linhas `recordType: "notice"` são
avisos do provedor e não são convertidas em publicações. Formatos inesperados
são rejeitados pela validação.

O período é enviado ao Actor e também conferido no service usando `takenAt`.
Posts sem data, futuros ou fora da janela são excluídos. Pode haver menos posts
que o limite ou nenhum. Não há garantia de cobertura completa do Instagram,
ordem cronológica ou cálculo de crescimento. O Actor suporta `pageId`, mas
esta rota ainda não expõe paginação.

Contrato do Actor: https://apify.com/seemuapps/instagram-keyword-posts-scraper

## Validação

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
```

Os modelos de domínio e os contratos definitivos serão adicionados após o fechamento da documentação técnica.

## Filtros e limites

Trends aceita `keywords` (1 a 10 strings) ou o campo legado `target`, exclusivamente.
`searchLimit` é por palavra-chave (1 a 250); palavras repetidas são removidas antes
da chamada única ao Actor. Cada post inclui `keyword` para identificar sua origem.
A mesma publicação pode aparecer para palavras diferentes, sem repetir dentro da mesma palavra.
`postType` aceita `all` (padrão), `reel`, `photo`, `carousel` ou `video`.
`minLikes` é um inteiro não negativo (padrão 0). Os filtros são enviados ao Actor
e reaplicados no service. Sem `locationName` preenchido, o post precisa de pelo
menos `max(minLikes, 1000)` likes; contagem desconhecida não cumpre um mínimo positivo.
Essa regra local pode reduzir a quantidade final e não comprova correspondência geográfica.

Posts aceita `resultLimits` de 1 a 50. Acima disso, a rota retorna 400 antes da coleta.
Profile/search responde 404 com `code: PROFILE_PRIVATE` para contas privadas e
`code: PROFILE_NOT_FOUND` para resultados ausentes ou erros explícitos de perfil inexistente.
Falhas operacionais do provedor não são convertidas em perfil inexistente.

## Autenticação

Todos os endpoints do Instagram exigem `Authorization: Bearer <JWT>`.
Health, documentação e a raiz permanecem públicos. Tokens devem ser assinados
com HS256, ter `sub` e `exp`, emissor `JWT_ISSUER` (padrão `hustleq`) e público
`JWT_AUDIENCE` (padrão `hustleq-social-data-api`). Tokens ausentes, inválidos ou
expirados retornam 401 com `code: UNAUTHORIZED`.

Configure `JWT_SECRET` com pelo menos 32 caracteres aleatórios no `.env` e no
ambiente de deploy. Não use o token da Apify como segredo JWT. O serviço emissor
precisa compartilhar esse segredo; ele não deve ser entregue ao frontend.
Não há endpoint público de emissão de tokens neste projeto.

Para gerar o segredo localmente, use `openssl rand -hex 32` e guarde o resultado
em `JWT_SECRET` no `.env`. Com a configuração pronta, gere um token de demo
(apenas para uso local, em terminal confiável):

```bash
node --import tsx --input-type=module -e 'import { buildApp } from "./src/app.ts"; const app = buildApp(); await app.ready(); console.log(app.jwt.sign({ sub: "demo" })); await app.close();'
```

No Postman/Insomnia, selecione Bearer Token e use o token gerado. A validade
padrão de emissão é de uma hora. O segredo é obrigatório também em deploy;
sem ele, a aplicação falha na validação da configuração ao iniciar.

## Erros de coleta e contrato de mídia

Execuções da Apify precisam terminar com status `SUCCEEDED` antes da leitura do
dataset. Recusas por limite retornam 429, `code: PROVIDER_RATE_LIMITED`, com a
mensagem do provedor. Falhas, interrupções, timeout ou indisponibilidade retornam
503, `code: PROVIDER_UNAVAILABLE`. Dados em formato inesperado retornam 503,
`code: PROVIDER_INVALID_RESPONSE`. Nenhuma dessas situações é devolvida como
uma busca bem-sucedida sem posts.

Em trends, um dataset composto somente por linhas `recordType: "notice"` retorna
429 se houver mensagem de limitação; caso contrário, retorna 503 com o aviso.
Isso inclui avisos de nenhum resultado. Uma mensagem explícita de limitação
junto de posts também provoca erro, para não esconder uma execução parcial.
Dataset vazio em execução bem-sucedida, ou posts excluídos pelos filtros locais,
ainda podem resultar em 200 com `posts: []`.

**Mudança de contrato para o marketing-agent: avisar Lucas antes do deploy.**
O campo de mídia usa somente `photo | carousel | reel`: em profile e post,
`posts[].type` / `response[].type`; em trends, `posts[].media.type`.
`Image` vira `photo`, `Sidecar` vira `carousel`, e `Video`/`video` vira `reel`.
O caminho dos campos não mudou. O request de trends ainda aceita `postType: "video"`
para filtrar vídeos de feed no Actor, embora sua representação de saída seja `reel`.

Hashtags precisam conter pelo menos uma letra Unicode. `4`, `#4` e `123` são
removidas; `rj2026`, `SãoPaulo` e palavras em outros alfabetos são mantidas.
A legenda original não é alterada. As hashtags são aparadas, sem o `#` inicial,
e sem duplicados idênticos.
