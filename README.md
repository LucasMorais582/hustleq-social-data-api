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

### Contas acompanhadas (concorrentes)

Todas as rotas usam JWT de usuário e exigem que `sub` seja o dono do perfil
monitorador. `{profileId}` é o ID interno string do InstagramProfile, não seu
instagramId. Não é necessário criar uma tabela User.

1. Confira a conta com `GET /api/v1/instagram/profiles/search?username=nome`.
   A prévia não cadastra a conta nem cria uma relação. A confirmação visual é
   responsabilidade do cliente.
2. Depois da confirmação, use
   `POST /api/v1/instagram/profiles/{profileId}/competitors` com:

   ```json
   { "username": "nome_do_concorrente" }
   ```

   Retorna 201 com `{ response: <relação criada> }`. Revalida a identidade na
   Apify, cadastra/reutiliza o perfil pelo instagramId e grava a relação e uma
   tarefa Initial Profile Sync na mesma transação. O lookup validado é
   reutilizado pelo worker; uma tarefa já ativa para o mesmo perfil é preservada.
   A API não transfere o dono nem altera reservas do perfil acompanhado.
   O worker separado deve estar habilitado para coletar posts e métricas.
   A prévia GET e a inclusão POST são duas consultas independentes à Apify.
   O body antigo com confirmed/confirmationToken passa a devolver 400.

3. `GET /api/v1/instagram/profiles/{profileId}/competitors?status=active&page=1&limit=50`
   mantém `{ response: { relations, page, limit } }`. Cada relação inclui seu
   `id` e `competitorProfileId` (ID interno para ler perfil/posts/histórico).
   `status`: active (padrão), ended ou all; limit: 1 a 100.
   Não expõe ownerUserId ou reservas.
4. `DELETE /api/v1/instagram/profiles/{profileId}/competitors/{relationId}`
   responde **204 sem corpo**. Preenche endedAt e preserva perfil e histórico.
   Repetir a remoção não muda endedAt. Adicionar novamente cria outra relação.
   A relação encerrada deixa de autorizar leituras pelo escopo COMPETITOR.

Autorreferência: 400 INVALID_REQUEST; três contas ativas: 409
COMPETITOR_LIMIT_REACHED; relação já ativa: 409 COMPETITOR_ALREADY_REGISTERED;
perfil monitorador inexistente: 404 PROFILE_NOT_FOUND; relação ausente ou de outro
perfil: 404 COMPETITOR_NOT_FOUND; outro usuário: 403 FORBIDDEN. As regras são
revalidadas em transação serializável depois do lookup. Falha ao agendar reverte
a identidade/relação, preservando o registro do custo da consulta.

A antiga `POST .../competitors/search` permanece depreciada e protegida pelo
mesmo acesso de dono. Seu comprovante não é mais aceito na inclusão; use a prévia
GET do contrato MVP. O Watched Sync diário ainda será implementado; o cron legado
continua selecionando perfis salvos e não deve ser confundido com esse job MVP.

## Adaptação MVP — etapa de autenticação e erros

O backend principal é o único cliente da Social Data API. Nas rotas de usuário,
o JWT deve usar `sub` com o ID do usuário HustleQ, sem claim `scope`. Não há
tabela User local. Tokens com `scope: service` não acessam essas rotas.

O guard `authenticateService` protege as rotas `/internal`:
exige `sub: "hustleq-main"` e `scope: "service"`, além das mesmas verificações de
assinatura, emissor, audiência e validade máxima de cinco minutos. Token válido
com papel inadequado retorna 403 FORBIDDEN; ausente ou inválido retorna 401
UNAUTHENTICATED. As rotas internas 2, 3, 4 e 11 usam esse guard.

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
pertencentes a perfis do usuário. Elas agora protegem as novas leituras 5, 6 e 7 do banco. As rotas legadas de coleta/concorrentes
continuam temporariamente com autenticação JWT, sem autorização por proprietário;
ainda não estão no contrato completo da MVP. Não liberar a integração de produção
como se essa migração já estivesse concluída.

Decisões confirmadas: manter IDs internos string CUID, sem conversão de IDs
existentes para UUID; seguir dois refreshes por conta no backend principal e
um teto configurável de dez por usuário nesta API. O teto e o refresh ainda
serão implementados na etapa própria; não há alteração de cota nesta entrega.

## Adaptação MVP — normalização dos retornos

A normalização de Profile/Post Scraper agora aceita likesCount=-1 e o converte
em likesCount=null, likesHidden=true. Contagem ausente continua null, com
likesHidden=false: ausência não comprova curtidas ocultas. O flag é salvo no
snapshot, separado do conteúdo do post, sem alterar snapshots anteriores.

Usernames de entrada/retorno são minúsculos, sem @. Hashtags ficam minúsculas,
sem #, sem duplicatas após normalização e sem hashtags compostas só de números.
Nome de perfil vazio vira null; bio preserva o texto recebido. A foto usa
profilePicUrlHD e, se ausente, profilePicUrl. IDs externos continuam strings.

Imagens usam a lista do provedor quando disponível; carrosséis podem recuperar
as imagens de childPosts na ordem recebida. Uma capa sozinha não é apresentada
como se fosse a lista completa do carrossel. Post de imagem única pode usar
displayUrl como sua imagem. Se faltar url, um shortCode válido permite construir
o permalink. Sem informação suficiente, o campo fica null/array vazio.

Os tipos das rotas legadas continuam photo/carousel/reel. O mapper para os novos
DTOs da MVP está preparado com IMAGE/CAROUSEL/REEL, sem mudar o enum do banco.
productType=clips também identifica um Reel quando type não vem preenchido.

**Mudança de dados:** novas coletas de Profile/Post Scraper não usam seus campos
de views como métrica confiável. viewsCount (e playsCount no post/search legado)
ficam null até o enriquecimento pelo Reel Scraper. O normalizador desse retorno
já prioriza videoPlayCount, preservando zero, e usa videoViewCount como fallback.
Sua execução/enriquecimento será ligada nos jobs; esta etapa não dispara outro
Actor nem consome créditos adicionais. Snapshots antigos não são reescritos.

As fixtures em tests/fixtures/instagram têm a origem registrada no próprio JSON:
formatos dos exemplos fornecidos pelo usuário e amostra adaptada da documentação
oficial do Reel Scraper (https://apify.com/apify/instagram-reel-scraper). Elas usam
identificadores/textos/URLs substituídos e casos sintéticos de limite. Não são
novas execuções reais. A validação de execução e enriquecimento com o Actor
continua pendente na etapa dos jobs.

## Leituras MVP — perfil, posts e histórico

As quatro leituras abaixo usam somente o banco, sem chamar a Apify nem iniciar
uma coleta. O JWT deve identificar o usuário da HustleQ em sub. O acesso exige
que ele seja o dono do perfil (ownerUserId) ou dono de um perfil que o acompanha
por uma relação ativa. Token de serviço não serve para essas rotas.

| Endpoint                                             | Resposta                                            |
| ---------------------------------------------------- | --------------------------------------------------- |
| GET /api/v1/instagram/profiles/{profileId}           | Perfil salvo e metrics com o snapshot mais recente  |
| GET /api/v1/instagram/profiles/{profileId}/posts     | Posts paginados e a métrica mais recente de cada um |
| GET /api/v1/instagram/profiles/{profileId}/snapshots | Histórico crescente dos snapshots de perfil         |
| GET /api/v1/instagram/posts/{postId}/metrics         | Histórico crescente das métricas de um post         |

profileId é o ID interno String da tabela InstagramProfile, não instagramId.
As respostas seguem os objetos diretos do guia, sem wrapper response. Elas não
expõem ownerUserId ou campos de reserva. syncStatus e lastSyncedAt refletem o
que está salvo; a leitura não altera esses campos nem descarta dados antigos.
Por decisão do usuário, isVerified continua null quando desconhecido.

Posts aceitam from, to, type=IMAGE|CAROUSEL|REEL, page (padrão 1) e limit
(padrão 30, máximo 50). total corresponde aos posts **salvos** que atendem aos
filtros, não à contagem total do Instagram. A ordem é timestamp decrescente,
com datas desconhecidas no fim e desempate estável por ID. Página acima do total
retorna posts=[]; quando não há resultados, totalPages=0. Tipos da resposta são
IMAGE/CAROUSEL/REEL. Sem snapshot, metrics=null; valores desconhecidos continuam
null. Views só são devolvidas em REEL e sem arredondamento de BigInt.

Snapshots aceitam from/to e são devolvidos em collectedAt crescente, sem
paginação nem criação de dias ausentes. Datas simples, como to=2026-11-21,
incluem o dia UTC inteiro; instantes ISO são limites inclusivos. Nos posts, o
intervalo filtra timestamp de publicação; no histórico, filtra collectedAt.

Exemplo, usando o ID interno real do perfil:

```text
GET /api/v1/instagram/profiles/ID_INTERNO/posts?type=REEL&page=1&limit=30&from=2026-11-01&to=2026-11-21
```

Um perfil inexistente retorna 404 PROFILE_NOT_FOUND; perfil existente sem escopo
retorna 403 FORBIDDEN. Histórico vazio retorna 200 e lista vazia. Falha no banco
retorna erro, sem fingir ausência de dados ou tentar consultar a Apify.
Perfis legados com ownerUserId nulo precisam da atribuicao de dono pelo endpoint
interno 3; estes GETs nao fazem essa atribuicao.

A tabela completa de funcionalidades e dos 16 endpoints fica na
[memória de implementação](docs/mvp-implementation-audit.md) e será atualizada
a cada etapa concluída.

## Perfis internos — atribuição de dono e liberação de reserva

Os endpoints 3 e 4 exigem um **token de serviço**, com sub=hustleq-main,
scope=service, HS256, iss/aud configurados e validade máxima de cinco minutos.
Um JWT normal de usuário é recusado com 403 FORBIDDEN. O backend principal
valida o convite e o usuário destinatário antes de chamar estas operações.

### Atribuir o dono — endpoint 3

```text
POST /api/v1/internal/instagram/profiles/ID_INTERNO/owner
```

```json
{ "userId": "ID_DO_USUARIO_HUSTLEQ" }
```

Retorna 200 com um objeto direto:

```json
{ "profileId": "ID_INTERNO", "ownerUserId": "ID_DO_USUARIO_HUSTLEQ" }
```

A operação grava ownerUserId e coloca reservedForInviteId/reservedUntil em null
na mesma transação. A reserva é temporária: ela indica qual convite reservou
o perfil e até quando; depois do aceite, o vínculo permanente é ownerUserId.
Repetir para o mesmo usuário é permitido. Um dono diferente gera 409
PROFILE_ALREADY_OWNED, sem transferir o perfil ou limpar a reserva.

userId é o destinatário da atribuição enviado pelo serviço autenticado, não
a identidade do chamador (que é hustleq-main). Não cria tabela ou conta User,
não consulta a Apify e não inicia sync. O backend principal continua responsável
por validar aceite, convite e existência do usuário na HustleQ.

### Liberar a reserva — endpoint 4

```text
DELETE /api/v1/internal/instagram/profiles/ID_INTERNO/reservation
```

Sem body; retorna 204 com corpo vazio. Limpa somente reservedForInviteId e
reservedUntil. Não remove ownerUserId, perfil, posts, snapshots ou relações.
Repetir quando já está sem reserva também retorna 204. Perfil inexistente
retorna 404 PROFILE_NOT_FOUND em ambas as rotas. Falha no banco é erro, não sucesso.

As duas operações usam transações serializáveis, com até três tentativas para
conflitos de serialização. A verificação de dono é repetida antes de gravar.
Não há mecanismo de transferência de dono nesta entrega.

Para teste local, gere um JWT de serviço somente em terminal confiável:

```bash
node --import tsx --input-type=module -e 'import { buildApp } from "./src/app.ts"; const app = buildApp(); await app.ready(); console.log(app.jwt.sign({ sub: "hustleq-main", scope: "service" })); await app.close();'
```

Use esse token no POST/DELETE internos. Para ler o perfil pelos endpoints 5–7,
use outro JWT, de usuário, com sub igual ao userId atribuído. Esses tokens não
devem ser enviados ao navegador. O endpoint 2 cria a reserva e enfileira o
Initial Sync, processado pelo worker separado.

## Histórico de métricas de um post

Use o `id` interno do post devolvido pela listagem de posts do perfil, e não
`instagramPostId`. Envie um JWT de usuário com acesso OWNER ou COMPETITOR ativo.

```text
GET /api/v1/instagram/posts/ID_INTERNO_DO_POST/metrics?from=2026-11-01&to=2026-11-21
Authorization: Bearer <JWT>
```

Resposta direta, com os snapshots em ordem crescente de coleta:

```json
{
  "postId": "ID_INTERNO_DO_POST",
  "metrics": [
    {
      "likesCount": 125,
      "likesHidden": false,
      "commentsCount": 14,
      "viewsCount": null,
      "collectedAt": "2026-11-18T11:02:10.000Z",
      "source": "initial"
    }
  ]
}
```

`source` indica a origem da coleta: `initial`, `daily`, `on_open` ou `refresh`.
O legado sem origem conhecida mantém `null`. As fontes `on_open` e `refresh`
estão previstas no contrato; os jobs que as produzirão continuam pendentes.

Os filtros opcionais `from`/`to` usam `collectedAt`, sem paginação. Datas simples
incluem o dia inteiro em UTC; instantes ISO têm limites inclusivos. Post salvo
sem snapshots no intervalo retorna 200 com `metrics: []`. Post inexistente
retorna 404 `POST_NOT_FOUND`; sem acesso retorna 403 `FORBIDDEN`.

A leitura não coleta nem altera dados, mesmo antigos. Curtidas ocultas retornam
`likesCount: null` e `likesHidden: true`; contagens desconhecidas permanecem
`null`, e zero continua zero. `viewsCount` só é devolvido para Reels. Falha do
banco retorna erro, sem mascará-la como histórico vazio.

## Monitoramento da coleta diaria

O backend principal configura o prazo usando token de servico
(`sub=hustleq-main`, `scope=service`):

```http
PATCH /api/v1/internal/instagram/profiles/ID_INTERNO/monitoring
Authorization: Bearer <JWT_DE_SERVICO>
Content-Type: application/json

{"monitoringUntil":"2026-12-21T00:00:00Z"}
```

Retorna 200 com a identidade do perfil, `syncStatus`, `lastSyncedAt` e
`monitoringUntil` em ISO UTC. Nao inclui dono, reserva ou snapshots. Perfil
inexistente retorna 404 `PROFILE_NOT_FOUND`; JWT de usuario retorna 403.

- Data futura: o perfil permanece elegivel ate esse instante.
- Data vencida, inclusive exatamente no instante da selecao: o cron exclui o perfil.
- `{"monitoringUntil":null}`: remove o prazo e permite as proximas coletas diarias.

O campo e obrigatorio. Aceita instante ISO com Z ou offset; data sem horario,
body vazio e campos extras retornam 400. O backend principal calcula os 30 dias
apos o plano ficar inativo; esta API salva exatamente o prazo recebido. Data
passada e aceita para suspender a participacao na proxima selecao.

O PATCH nao dispara coleta, nao altera acesso de leitura e preserva dono,
reserva, posts e historico. O cron aplica o filtro ao selecionar o lote: uma
alteracao nao cancela uma execucao ja iniciada ou um lote ja selecionado. O
horario atual das 6h de Nova York e os demais criterios do cron continuam os
mesmos; a migracao para os jobs Daily/Watched da MVP permanece pendente.

## Fila interna para a VPS

A tabela InstagramSyncJob foi aplicada ao banco de desenvolvimento. As operacoes
internas de enfileiramento, reserva atomica, renovacao de posse e conclusao/falha
estao em `src/modules/instagram/jobs`. Nao ha endpoint publico para essa fila.

A regra confirmada e tres tentativas no total: inicial, espera de 1 minuto e
espera de 5 minutos. A terceira falha encerra o job. Jobs concluidos permanecem
no historico e liberam sua chave ativa para uma nova coleta.

O processo do worker, integracao com Actors/custos e recuperacao apos uma queda
ainda estao pendentes. Nenhuma rota comeca a coletar em segundo plano apenas por
existirem a tabela e essas operacoes. O cron legado continua como antes.

## Worker Initial Profile Sync — processo separado

O primeiro executor da fila suporta `INITIAL_PROFILE_SYNC`. O cron legado e
as rotas antigas continuam com seu comportamento atual; este worker nao
transforma todos os perfis salvos em novas tarefas. O endpoint 2 (convite) ja enfileira esses jobs. O endpoint 14 ainda precisa
ser adaptado ao novo contrato de conta acompanhada.

Configuracao (desabilitado por padrao):

```dotenv
INSTAGRAM_WORKER_ENABLED=false
INSTAGRAM_WORKER_POLL_MS=5000
```

Depois de configurar banco/Apify e decidir iniciar o consumo das tarefas,
defina `INSTAGRAM_WORKER_ENABLED=true` no ambiente do processo do worker.
Executar um job real consome os creditos dos Actors correspondentes.

Desenvolvimento, em terminal separado da API:

```bash
npm run dev:worker
```

Na VPS, depois do build, API e worker sao processos distintos:

```bash
npm start
```

```bash
npm run start:worker
```

Nenhuma VPS foi acessada ou configurada nesta etapa. O processo trata SIGINT e
SIGTERM, termina o job atual e fecha a conexao antes de sair. O supervisor deve
permitir esse encerramento; se houver queda, a posse vencida pode ser retomada.

O executor coleta o perfil, seleciona ate 12 posts retornados do proprio autor
por data decrescente, e consulta apenas as URLs dos Reels selecionados. As views
vem do Reel Scraper; ausencia continua null. Nao solicita transcript, download
ou shares. O Profile Scraper nao garante acesso a todo o historico do Instagram.

Cada execucao usada por este worker registra ProviderRun com usuario/dono
conhecido, Actor, apifyRunId, estado, quantidade e usageTotalUsd quando disponivel.
Custo desconhecido permanece null. Isso ainda nao instrumenta todas as chamadas
legadas nem implementa GET /internal/costs. O payload interno do job guarda as
referencias das etapas para permitir retomada sem iniciar outro Actor conhecido.

Perfil, snapshots, syncStatus ready, lastSyncedAt e conclusao da tarefa sao
persistidos na mesma transacao, com validacao da posse antes/depois. O historico
e o intervalo atual de 24h para snapshots do perfil sao preservados. Falha agenda
as tres tentativas confirmadas; depois, syncStatus fica failed sem apagar dados.

Se uma conexao cair no inicio e nao for possivel persistir o id da Apify, o job
registra PROVIDER_START_UNCERTAIN e nao repete automaticamente aquele POST. Esse
caso exige reconciliacao operacional; a API nao promete execucao exatamente uma
vez nem inventa custo zero para a execucao incerta.

Testes locais usam transporte Apify simulado. Teste PostgreSQL opt-in:

```bash
RUN_DATABASE_TESTS=true npx vitest run tests/instagram-initial-sync.integration.test.ts
```

Esse teste usa schema temporario proprio e limpeza confirmada, sem Actors pagos
nem alteracao de registros do schema public. Valores de custo sao fixtures,
nao medicoes de cobranca reais. O teste inclui espera controlada para comprovar
rollback quando a posse vence antes do commit.

Contrato do Actor conferido na [documentacao oficial do Reel Scraper](https://apify.com/apify/instagram-reel-scraper/api/openapi).

## Criar a reserva do convite — endpoint 2

Chamado pelo backend principal com token de servico, antes da conta HustleQ existir:

```http
POST /api/v1/internal/instagram/profiles
Authorization: Bearer <JWT_DE_SERVICO>
Content-Type: application/json

{
  "username": "bahiataste",
  "inviteId": "ID_DO_CONVITE",
  "reservedUntil": "2026-11-30T04:59:59Z"
}
```

Use uma data futura real em reservedUntil. Aceita username com/sem @ e normaliza
minusculas. Campos extras, data sem horario/fuso e data vencida retornam 400.

Resposta 201, sem wrapper:

```json
{
  "profileId": "ID_INTERNO_STRING",
  "username": "bahiataste",
  "status": "syncing"
}
```

A requisicao aguarda a consulta de identidade na Apify para obter o instagramId
real. Depois cria/reutiliza InstagramProfile sem dono, reserva para o convite e
enfileira o Initial Profile Sync na mesma transacao. O worker reaproveita o
apifyRunId desse lookup: nao inicia outra coleta de perfil para o mesmo job.
Snapshots e Reels ficam para o worker; ele precisa estar habilitado e executando.

Um perfil ready coletado ha menos de 24h e sem job ativo pode responder status
ready sem enfileirar outro sync. Na marca de 24h ja e considerado desatualizado.
Repetir o convite preserva o ID e nao duplica um job ativo. Cada POST, porem, pode
realizar nova consulta de identidade e consumir credito; nao e garantia de
cobranca unica entre varias requisicoes.

Erros principais:

| HTTP    | Codigo                              | Motivo                                            |
| ------- | ----------------------------------- | ------------------------------------------------- |
| 400     | INVALID_REQUEST                     | Body invalido ou reservedUntil vencido            |
| 401/403 | UNAUTHENTICATED / FORBIDDEN         | Token ausente/invalido ou sem papel de servico    |
| 404     | PROFILE_NOT_FOUND / PROFILE_PRIVATE | Perfil inexistente ou privado                     |
| 409     | PROFILE_ALREADY_OWNED               | Perfil ja possui dono                             |
| 409     | PROFILE_RESERVED                    | Outro convite possui reserva ativa                |
| 429     | RATE_LIMITED                        | Apify recusou por limite                          |
| 503     | PROVIDER_UNAVAILABLE                | Provider falhou ou inicio nao pode ser confirmado |
| 500     | INTERNAL_ERROR                      | Falha ao salvar reserva/fila                      |

Reserva expirada pode ser substituida; nenhuma dessas operacoes transfere dono
ou apaga historico. O aceite continua no POST .../:profileId/owner, e a liberacao
no DELETE .../:profileId/reservation. O backend principal valida os convites e
os destinatarios; esta API nao cria tabela User ou Invite.

Custos reais conhecidos do lookup ficam em ProviderRun mesmo quando ocorre
conflito ou falha posterior. Antes de existir dono, userId fica null. O limite
de execucao de 60s do Actor nao comprova um SLA HTTP; latencia/cobranca reais
precisam de validacao com o ambiente de integracao.

Teste PostgreSQL opt-in, com Apify simulado e schema temporario proprio:

```bash
RUN_DATABASE_TESTS=true npx vitest run tests/instagram-profile-reservation.integration.test.ts
```

## Pesquisa de perfil antes do convite — endpoint 1

```http
GET /api/v1/instagram/profiles/search?username=bahiataste
Authorization: Bearer <JWT_DE_USUARIO>
```

Essa rota segue o guia da MVP. A rota legada POST
`/api/v1/instagram/profile/search` continua disponivel e salva a coleta como
antes. O novo GET e uma previa: consulta a Apify e retorna a identidade e a
situacao do vinculo no banco da HustleQ, sem cadastrar/reservar perfil ou salvar
posts/snapshots. A consulta/normalizacao e compartilhada com o fluxo do convite.

Use JWT com sub do usuario HustleQ, sem scope; token de servico recebe 403.
Username aceita @ e e normalizado para minusculas. A escrita permitida nesta
busca e somente o registro de execucao/custo em ProviderRun, com trigger search
e userId vindo do token. Nao ha tabela User local.

Resposta 200 direta:

```json
{
  "instagramId": "123456789",
  "username": "bahiataste",
  "name": "Bahia Taste",
  "bio": "...",
  "profilePhoto": "https://...",
  "isVerified": null,
  "followers": 1358,
  "following": 210,
  "postsCount": 96,
  "ownershipStatus": "available"
}
```

Campos desconhecidos permanecem null; zero continua zero. Nao retorna posts,
ID interno, ownerUserId ou informacoes do convite.

| ownershipStatus | Significado                                               |
| --------------- | --------------------------------------------------------- |
| available       | Perfil existe no Instagram, sem dono/reserva ativa na API |
| owned_by_me     | ownerUserId corresponde ao sub do token                   |
| owned_by_other  | Perfil possui outro dono na API                           |
| reserved        | Perfil sem dono, com convite e prazo de reserva ativo     |
| not_found       | Perfil nao encontrado no Instagram                        |

Dono tem prioridade sobre metadados de reserva. Reserva expirada, inclusive no
instante exato do vencimento, nao bloqueia a disponibilidade. A consulta usa o
instagramId real; uma mudanca de username nao cria outro vinculo. O resultado
e uma previa: a criacao do convite revalida os conflitos no POST interno.

Para inexistente, o GET novo retorna 200 com somente:

```json
{ "username": "bahiataste", "ownershipStatus": "not_found" }
```

Perfil privado continua com 404 PROFILE_PRIVATE. Falha/timeout da Apify retorna
503 PROVIDER_UNAVAILABLE e limite retorna 429 RATE_LIMITED; nao viram not_found.
Falha no banco retorna erro, sem assumir available. Query extra/invalida e 400.

Cada GET pode consumir uma nova consulta Apify. O lookup do POST de convite e
uma execucao distinta; o worker reaproveita a execucao desse POST. Nao prometer
cobranca unica para o conjunto GET/POST ou entre chamadas repetidas.

A busca usa Actor com timeout de 20s, polling de ate 2s por chamada e timeout de
transporte de 5s, sem retry automatico do POST. Ha orcamento local de 25s para o
lookup e transacao curta para ler ownership. Isso limita esperas, mas nao comprova
SLA real menor que 30s sob falha/latencia de banco ou rede. Execucao interrompida
com ID conhecido permanece rastreavel no ProviderRun, com custo desconhecido
null; reconciliacao geral de custos fora do worker ainda esta pendente.
