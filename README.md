# HustleQ Social Data API

Social Data API da HustleQ Beta.

Auditoria do guia da MVP de 18/11/2026, diferenças de contrato e próximas etapas:
[memória de implementação](docs/mvp-implementation-audit.md). As seções abaixo
descrevem a implementação atual; não significam que o contrato completo da MVP
já esteja entregue.

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
com HS256, ter `sub`, `iat` e `exp`, emissor `JWT_ISSUER` (padrão `hustleq`) e público
`JWT_AUDIENCE` (padrão `hustleq-social-data-api`). Tokens ausentes, inválidos ou
expirados retornam 401 com `error.code: UNAUTHENTICATED`. A duração máxima aceita
é de cinco minutos (`exp - iat <= 300`); `iat` não pode estar no futuro.

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
padrão de emissão é de cinco minutos. O segredo é obrigatório também em deploy;
sem ele, a aplicação falha na validação da configuração ao iniciar.

## Erros de coleta e contrato de mídia

Execuções da Apify precisam terminar com status `SUCCEEDED` antes da leitura do
dataset. Recusas por limite retornam 429, `error.code: RATE_LIMITED`, com a
mensagem do provedor. Falhas, interrupções, timeout ou indisponibilidade retornam
503, `error.code: PROVIDER_UNAVAILABLE`. Dados em formato inesperado retornam 503,
`error.code: PROVIDER_UNAVAILABLE`. Nenhuma dessas situações é devolvida como
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

## Coleta diária (Vercel)

A rotina de todos os perfis salvos está preparada para a janela das 6h de
`America/New_York`. Para ativar em produção, configurar `CRON_SECRET` (segredo
aleatório de pelo menos 32 caracteres, separado do JWT) e
`INSTAGRAM_REFRESH_ENABLED=true`, e fazer deploy com `vercel.json`.
Manter `INSTAGRAM_REFRESH_ENABLED=false` no desenvolvimento evita coleta automática.
A rotina não roda apenas por iniciar `npm run dev`.

Detalhes de horários, limites do Vercel e da versão simples estão em
[prisma/README.md](prisma/README.md#etapa-5--rotina-diária-simples-no-vercel).
Ela atualiza métricas coletadas dos dez posts mais recentes e conserva os snapshots
anteriores. Não cria User, não grava trends nem adiciona tabela de controle.

### Concorrentes: busca e confirmação

Todas as rotas abaixo exigem o JWT de acesso em `Authorization: Bearer <token>`.
`{profileId}` é o **ID interno** de um `InstagramProfile` já salvo (coluna `id`
no Supabase), não o `instagramId` nem o username. A relação continua sendo
InstagramProfile → InstagramProfile; não há criação de User nesta etapa.

1. `POST /api/v1/instagram/profiles/{profileId}/competitors/search`

   ```json
   { "username": "nome_do_concorrente" }
   ```

   Aceita `@` inicial. Consulta a Apify e devolve `response.profile` com
   `instagramId`, `username`, `name`, `bio`, `profilePhoto`, `url`, `category`
   e `isVerified`, além de `response.confirmationToken` e `response.expiresAt`.
   Campos indisponíveis podem ser null. A foto usa a URL da Apify, sem upload.
   A busca **não salva** o concorrente, posts, snapshots ou relação. Cada busca
   consome uma consulta ao provider. Perfil inexistente ou privado devolve 404
   com `PROFILE_NOT_FOUND` ou `PROFILE_PRIVATE`; falhas/limites do provider
   preservam os erros 503/429 existentes.

2. Depois da conferência, `POST /api/v1/instagram/profiles/{profileId}/competitors`

   ```json
   { "confirmed": true, "confirmationToken": "copie_o_token_da_busca" }
   ```

   Retorna 201 com `response` contendo a relação criada. O comprovante vale por
   dez minutos e é vinculado ao perfil monitorador e ao `sub` do JWT de acesso.
   Não é um token de autenticação. A confirmação não consulta novamente a Apify:
   salva a identidade apresentada na busca, reutilizando o perfil pelo
   `instagramId`, e cria a relação na mesma transação. Não atribui proprietário.
   Não salva posts nem métricas nesta operação; a coleta normal e a rotina diária
   continuam responsáveis por esses dados. Para cancelar, basta não confirmar;
   `confirmed: false` ou ausente é rejeitado com 400.

3. `GET /api/v1/instagram/profiles/{profileId}/competitors?status=active&page=1&limit=50`
   lista as relações e a identidade atual do concorrente. `status` aceita
   `active` (padrão), `ended` e `all`; `limit` vai de 1 a 100.

4. `DELETE /api/v1/instagram/profiles/{profileId}/competitors/{relationId}`
   encerra a relação preenchendo `endedAt`, sem apagar histórico ou perfil.
   Repetir a remoção preserva o encerramento original. Reconfirmar uma busca
   depois do encerramento cria outra relação.

Erros de negócio: 400 `INVALID_REQUEST` (autorreferência ou confirmação inválida); 409 `COMPETITOR_ALREADY_REGISTERED` ou
`COMPETITOR_LIMIT_REACHED` (máximo de três ativos); 404
`COMPETITOR_NOT_FOUND` para relação ausente ou de outro perfil.
A confirmação revalida as regras dentro de uma transação serializável, inclusive
se houver outras confirmações depois da busca. Falhas revertem toda a operação.

Como User e sua integração com a HustleQ ainda estão em definição, estas rotas
validam o JWT, mas ainda não verificam propriedade do perfil por usuário.

## Adaptação MVP — etapa de autenticação e erros

O backend principal é o único cliente da Social Data API. Nas rotas de usuário,
o JWT deve usar `sub` com o ID do usuário HustleQ, sem claim `scope`. Não há
tabela User local. Tokens com `scope: service` não acessam essas rotas.

O guard `authenticateService` está preparado para as próximas rotas `/internal`:
exige `sub: "hustleq-main"` e `scope: "service"`, além das mesmas verificações de
assinatura, emissor, audiência e validade máxima de cinco minutos. Token válido
com papel inadequado retorna 403 FORBIDDEN; ausente ou inválido retorna 401
UNAUTHENTICATED. As rotas de convites/internal ainda não foram criadas nesta etapa.

O formato dos erros das rotas de negócio passou a ser:

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Token Bearer ausente, inválido ou expirado",
    "time": "2026-11-19T12:00:00.000Z"
  }
}
```

Validação de entrada retorna 400 INVALID_REQUEST. Limite do provider retorna
429 RATE_LIMITED; indisponibilidade/resposta inválida do provider retorna
503 PROVIDER_UNAVAILABLE. Falhas internas de persistência retornam 500
INTERNAL_ERROR, sem expor credenciais, SQL ou stack no corpo. Falhas de negócio
preservam seu status com os códigos do contrato: por exemplo,
COMPETITOR_ALREADY_REGISTERED e COMPETITOR_NOT_FOUND. A rota legada de cron
continua com CRON_SECRET e seu contrato anterior até a migração dos jobs.

As verificações reutilizáveis de leitura OWNER/COMPETITOR foram preparadas em
`src/auth/instagram-access.ts`, com base em ownerUserId e em relações ativas
pertencentes a perfis do usuário. Elas serão ligadas às novas leituras do banco
quando esses endpoints forem criados. As rotas legadas de coleta/concorrentes
continuam temporariamente com autenticação JWT, sem autorização por proprietário;
ainda não estão no contrato completo da MVP. Não liberar a integração de produção
como se essa migração já estivesse concluída.

Decisões confirmadas: manter IDs internos string CUID, sem conversão de IDs
existentes para UUID; seguir dois refreshes por conta no backend principal e
um teto configurável de dez por usuário nesta API. O teto e o refresh ainda
serão implementados na etapa própria; não há alteração de cota nesta entrega.
