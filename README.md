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

## Coleta diária — VPS

A rota existente `GET /api/cron/instagram-refresh` agora **enfileira** o Daily Sync
na janela das **4h de America/New_York**, acompanhando o horário de verão. Ela não
executa Actors durante o HTTP. Exige `Authorization: Bearer SEU_CRON_SECRET`,
CRON_SECRET configurado e INSTAGRAM_REFRESH_ENABLED=true. O worker separado
precisa estar ativo para executar as tarefas.

O Daily seleciona somente perfis com ownerUserId e monitoringUntil nulo ou futuro.
As contas acompanhadas sem dono serão tratadas pelo Watched Sync, ainda pendente.
Coleta até doze posts próprios retornados por perfil, com métricas de Reels e
snapshots automáticos separados por pelo menos vinte horas. Lotes nunca misturam
donos. A configuração completa e os limites estão na seção Daily Sync abaixo.
Nenhum agendamento foi instalado na VPS nesta etapa; iniciar npm run dev sozinho
não dispara o cron. As duas expressões Vercel foram alinhadas para 8h/9h UTC por
compatibilidade, sem fazer deploy ou mudar o destino confirmado (VPS).

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
GET do contrato MVP. O Watched Sync diário foi implementado na etapa R e usa
relações ativas elegíveis, conforme a seção ao final deste documento.

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

O Initial Sync coleta o perfil e usa apify/instagram-post-scraper para buscar
posts dos ultimos 90 dias, com teto INSTAGRAM_INITIAL_MAX_POSTS (padrao 500,
aceita 1–1000). O teto vale para todo o Initial, incluindo posts do Profile
Scraper. A janela e o teto sao gravados no payload na primeira tentativa e nao
mudam ao reiniciar o worker. Usa onlyPostsNewerThan absoluto, preserva posts
fixados recentes, valida ownerId e datas, deduplica e ordena por timestamp.
Depois consulta somente os Reels selecionados para obter views confiaveis.
Nao solicita transcript, download, musica ou shares. Campos ausentes ficam null.

O log initial_sync inclui history.from/to/limit/returnedCount/limitReached.
Atingir o teto sinaliza possivel cobertura parcial, nao garante que todo o
historico foi obtido. Restricoes do Actor/Instagram tambem podem limitar a coleta.
Nao houve execucao paga para medir cobertura, tempo ou custo deste novo fluxo.
Daily e Watched continuam atualizando somente os 12 posts mais recentes.
Perfis ja sincronizados nao recebem backfill automaticamente nesta mudanca.

Cada execucao usada por este worker registra ProviderRun com usuario/dono
conhecido, Actor, apifyRunId, estado, quantidade e usageTotalUsd quando disponivel.
Custo desconhecido permanece null. Isso ainda nao instrumenta todas as chamadas
legadas nem implementa GET /internal/costs. O payload interno do job guarda as
referencias das etapas para permitir retomada sem iniciar outro Actor conhecido.

Posts e primeiras metricas do Initial sao persistidos em lotes de dez, com
checkpoint atomico no payload (initialHistory.savedPostIds) e validacao de lease.
Retomar um lote concluido nao duplica snapshots nem inicia Actors conhecidos.
O perfil permanece syncing ate o ultimo lote, quando ready/lastSyncedAt e a
conclusao do job sao gravados atomicamente. Dados parciais permanecem salvos em
falha; as tres tentativas continuam vigentes. Metricas existentes mais novas nao
sao substituidas por uma coleta atrasada. A primeira metrica historica representa
o momento da coleta, nao a data da publicacao.

Snapshots de seguidores novos dos jobs recebem source initial ou daily; os
anteriores permanecem null. O campo tambem e exposto em GET profiles/:id.metrics
e GET profiles/:id/snapshots. Aplicar a migration
20261126000000_add_profile_snapshot_source antes de publicar API/worker novos.

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
  "profileId": null,
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

Campos desconhecidos permanecem null; zero continua zero. profileId é o ID
interno quando o perfil já existe no banco, inclusive se estiver reservado ou
pertencer a outro usuário; caso contrário, null. Não retorna posts, ownerUserId
ou informações do convite. Conhecer o ID não concede acesso de leitura.

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
{ "profileId": null, "username": "bahiataste", "ownershipStatus": "not_found" }
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

## Custos mensais — endpoint 12

`GET /api/v1/internal/costs?month=2026-11` exige token de serviço
(`sub=hustleq-main`, `scope=service`). O mês é obrigatório no formato `YYYY-MM`.
A rota consulta somente ProviderRun, sem chamar a Apify ou modificar dados.

O mês é delimitado por **startedAt em UTC**: início inclusivo, início do mês
seguinte exclusivo. Uma execução iniciada em novembro e encerrada em dezembro
pertence a novembro. Todos os status entram na contagem: falhar não implica
custo zero. Os valores estão em USD, com soma Decimal antes da serialização.

```json
{
  "month": "2026-11",
  "totalUsd": null,
  "byUser": [
    { "userId": "usuario-a", "costUsd": 0.1, "runs": 2 },
    { "userId": "usuario-b", "costUsd": null, "runs": 1 }
  ],
  "byTrigger": [
    { "trigger": "initial", "costUsd": 0.1, "runs": 2 },
    { "trigger": "search", "costUsd": null, "runs": 1 }
  ],
  "unattributedUsd": 0
}
```

Por decisão confirmada, totalUsd/costUsd/unattributedUsd aceitam **null** quando
há custo desconhecido no conjunto correspondente. A contagem runs inclui todas
as execuções, mesmo com custo null. Os grupos completos continuam numéricos.
Custo zero conhecido permanece 0. Mês sem registros retorna totalUsd 0,
unattributedUsd 0 e listas vazias. Execuções sem userId entram em unattributedUsd
e em byTrigger, sem criar um usuário fictício em byUser.

O relatório é do ledger existente, não uma consulta à fatura da Apify. A cobertura
está nos fluxos já rastreados (busca GET, convites, inclusão de concorrentes e
worker Initial); a instrumentação dos fluxos legados e a conciliação de execuções
incertas ainda estão pendentes. Valores de meses anteriores podem mudar quando
um custo desconhecido for preenchido. Não há estimativa nem conversão cambial.

Query inválida retorna 400; token inválido/expirado, 401; token de usuário, 403.
Falhas de banco ou valores fora da precisão suportada retornam 500 sanitizado.
A resposta usa Cache-Control private, no-store e o contrato aparece no Swagger.

## Consulta e refresh de um post salvo — endpoints 8 e 10

As duas rotas exigem token de usuário e acesso OWNER ou COMPETITOR ao perfil do
post. `postId` é o ID interno string da Social Data API, não o ID do Instagram.

- `GET /api/v1/instagram/posts/{postId}` retorna 200 com o mesmo objeto de post
  da listagem quando lastCollectedAt tem menos de 24 horas. Com 24 horas exatas,
  mais tempo ou coleta ausente, cria uma tarefa on_open e retorna:

  ```json
  { "status": "refreshing", "post": { "id": "id-interno", "...": "dados salvos" } }
  ```

  O status HTTP é 202. Os dados anteriores continuam disponíveis enquanto o
  worker trabalha. Consulte o GET novamente para obter o resultado. Se já houver
  atualização em andamento, retorna 202 também, mesmo com métricas recentes.

- `POST /api/v1/instagram/posts/{postId}/refresh`, sem body, agenda uma coleta
  manual mesmo com dados recentes e retorna 202 `{ "status": "refreshing" }`.
  Uma tarefa pendente, em retry ou rodando para o post é reutilizada. Um
  ProviderRun running iniciado há menos de dez minutos também bloqueia duplicação.

Configure o teto de segurança no ambiente:

```dotenv
INSTAGRAM_MANUAL_REFRESH_DAILY_LIMIT=10
```

O limite é por usuário do JWT, somando todos os posts que ele pode acessar.
Zera à meia-noite UTC e usa o relógio do PostgreSQL. Cada tarefa manual aceita
consome uma unidade, **mesmo se falhar depois**. Retry da mesma tarefa não consome
outra unidade; reaproveitar uma tarefa em andamento também não. on_open não conta.
A contagem usa InstagramSyncJob persistido, inclusive FAILED/SUCCEEDED, e uma
trava transacional por usuário evita ultrapassar o teto com chamadas simultâneas
para posts diferentes. Não apagar jobs históricos, pois são o registro da cota.
A cota comercial de dois por conta continua no backend principal.

O processo separado `npm run start:worker`, com INSTAGRAM_WORKER_ENABLED=true,
executa Initial Sync e Post Refresh. Sem o worker, 202 significa tarefa gravada,
mas ela não será processada. São três tentativas no total, com esperas de um e
cinco minutos. Lease expirado é retomado com outro token na mesma tentativa;
execuções Apify conhecidas são consultadas novamente, sem outro POST de início.
Início incerto sem apifyRunId não é repetido cegamente e requer conciliação.

Reels usam instagram-reel-scraper; foto/carrossel usam instagram-scraper com URL
canônica /p/, resultsType posts e resultsLimit 1, conforme o
[OpenAPI oficial](https://apify.com/apify/instagram-scraper/api/openapi).
A escolha atende o guia; menor custo real ainda não foi comprovado em benchmark.
O worker valida o ID do post, autor e tipo antes de gravar. Acrescenta snapshot
com source on_open/refresh e atualiza lastCollectedAt na mesma transação que
conclui o job; conteúdo estável e snapshots anteriores são preservados. Views
só vêm do Reel Scraper; campos indisponíveis ficam null. ProviderRun registra a
execução e seu custo conhecido/null, atribuído ao dono do perfil ou ao solicitante
quando o perfil não tem dono, seguindo a regra usada pelo Initial Sync.

Falhas mantêm o histórico e lastCollectedAt anterior. Perda de posse ou expiração
do lease impede commit do worker antigo. Não há atualização de perfil nesta rota
nem alteração do cron diário. Erros: 404 POST_NOT_FOUND, 403 FORBIDDEN,
429 MANUAL_REFRESH_LIMIT_REACHED, além de 400/401/500; URL salva sem suporte retorna
503 PROVIDER_UNAVAILABLE. Queries extras e body com parâmetros são rejeitados.
Nenhuma chamada Apify é feita durante a requisição HTTP.

## Discover — endpoint 16

```http
GET /api/v1/instagram/discover?niche=Brazilian%20food&city=Newark%2C%20NJ&query=
Authorization: Bearer TOKEN
```

`niche` e `city` são obrigatórios; `query` é opcional. Cada componente normalizado
aceita até 200 caracteres (entrada bruta até 400). Não recebe filtros de tipo,
período, mínimo de likes ou paginação: o app filtra os resultados localmente.
Exige token de usuário; também aceita o token de serviço exato para aquecimento
pelo backend principal. Nenhuma tabela User ou cadastro de perfil é necessário.

A busca combina nicho, cidade e query em **um termo**, nessa ordem. Por exemplo,
`brazilian food newark, nj feijoada`. O Actor recebe um item em keywords,
maxPostsPerKeyword 50, postType all, minLikes 0 e dateFrom "30 days", conforme o
[OpenAPI da Seemu](https://apify.com/seemuapps/instagram-keyword-posts-scraper/api/openapi).
Não aplica a regra de mil likes para posts sem localização do Trends legado.
É pesquisa textual; não garante localização geográfica exata nem cobertura de
50 posts válidos. Posts sem data, futuros ou fora dos 30 dias da coleta são
excluídos, duplicados removidos e o resultado ordenado por data decrescente.

Cache compartilhado por 24 horas entre todos os usuários. Normaliza caixa,
acentos e espaços; query vazia vira null. A chave usa a tupla JSON dos três
componentes, evitando colisões de delimitadores. FetchedAt usa relógio do banco.
Com menos de 24 horas, retorna o cache sem Actor novo. Com 24 horas exatas,
cache ausente ou data futura, cria/reutiliza um job Discover Search. Uma trava
no banco por chave coordena chamadas simultâneas, inclusive de usuários distintos.

Com cache válido, a resposta é 200 com objeto direto:

```json
{
  "fromCache": true,
  "fetchedAt": "2026-11-23T12:00:00.000Z",
  "niche": "brazilian food",
  "city": "newark, nj",
  "query": null,
  "posts": []
}
```

Posts usam os campos do guia: instagramPostId string, url, type
REEL/CAROUSEL/IMAGE, caption, hashtags, displayUrl, timestamp, ownerUsername,
ownerFullName, likesCount, likesHidden, commentsCount e viewsCount. Indisponíveis
ficam null; hashtags são normalizadas; -1 em likes vira null/likesHidden true;
views só são expostas para Reels. Os dados são gravados somente em DiscoverCache,
sem criar perfis, posts ou snapshots de métricas no domínio monitorado.

Sem cache válido, a API cria/reutiliza um job e responde imediatamente:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{"status":"searching"}
```

O backend consulta a mesma URL novamente. Enquanto houver job pendente ou em
execução, recebe 202 sem criar outro job. Depois da publicação, recebe 200 com
fromCache true. Não há mais espera HTTP nem INSTAGRAM_DISCOVER_WAIT_MS; a variável
antiga pode ser removida da configuração. O worker continua necessário, em
processo separado, com INSTAGRAM_WORKER_ENABLED=true.

**Integração de cotas:** o 202 não distingue criação de job de polling. Não
contar cada polling como nova busca. A lógica anterior baseada em fromCache false
precisa ser ajustada no backend principal; a API não implementa a cota comercial.
Custo fica no ProviderRun do primeiro solicitante; aquecimento service usa userId
null. Este contrato não acrescenta identificador público de job.

O job tem três tentativas totais, esperas de um e cinco minutos e recuperação de
lease sem repetir um Actor conhecido. Publicação do cache e conclusão do job são
atômicas e protegidas pelo token de posse. Cache vencido permanece armazenado se
a atualização falhar, mas **não é devolvido**. Nas consultas após falha final, retorna 429 RATE_LIMITED ou 503
PROVIDER_UNAVAILABLE por um minuto, com mensagem sanitizada. Depois desse minuto,
sem cache válido e sem job ativo, uma consulta pode iniciar nova tentativa. Isso
evita que polling reinicie buscas pagas imediatamente após cada falha. Dataset só de
avisos não vira sucesso vazio. Dataset genuinamente vazio pode gerar posts [].

Nenhum agendamento novo foi criado para aquecimento: o backend principal chama
a mesma rota com token de serviço. Trends/search mantém seu contrato e continua
sem persistência. Latência, custo e cobertura reais do Actor ainda precisam de
validação autorizada; os testes desta etapa simulam o transporte Apify.

## Daily Sync — lotes por usuário e contagem por dia de Nova York

O Daily inicia às 4h de Nova York e forma lotes somente por ownerUserId.
A deduplicação do Daily usa o dia civil em America/New_York: se já existe um
snapshot de seguidores nesse dia, não abre outra coleta diária. lastSyncedAt
continua indicando a última sincronização, mas não impede a contagem do dia seguinte.

```dotenv
INSTAGRAM_REFRESH_ENABLED=true
INSTAGRAM_WORKER_ENABLED=true
INSTAGRAM_DAILY_BATCH_SIZE=5
```

CRON_SECRET também deve estar configurado. O tamanho do lote aceita 1–10 perfis.
Desabilitar INSTAGRAM_REFRESH_ENABLED impede novos enqueues pelo cron; os jobs
ja gravados continuam sob controle do worker e da elegibilidade de monitoramento.
A rota GET /api/cron/instagram-refresh ignora chamadas fora de 4h00–4h59 em
America/New_York. Um scheduler da VPS pode chamá-la a cada hora UTC: a própria
rota faz a seleção da janela local, sem depender do fuso do sistema operacional.
O agendamento e o deploy continuam pendentes. A meta é concluir antes da leitura
das 6h do backend principal; isso depende de volume, latência e capacidade dos
workers e ainda precisa de medição real.

O retorno do cron descreve **enfileiramento**, não coleta concluída: total,
queued, reused, notDue, failed, pending e failures. Um 200 não comprova que os
Actors já terminaram. Falha no enqueue ou orçamento de 180s excedido retorna 503
com o resumo; repetir dentro da janela reaproveita os jobs e continua o restante.
O histórico impede iniciar outra sequência de três tentativas para o mesmo
perfil/data local, mesmo se a sequência anterior terminou em falha.

São elegíveis perfis próprios com dono e monitoramento vigente. Owner e prazo
são revalidados ao enfileirar, ao executar e antes de gravar cada perfil. Perfil
com contagem de seguidores no mesmo dia de Nova York é ignorado, inclusive se
a contagem veio de outra sincronização. A checagem se repete antes do Actor e
na persistência; os limites UTC respeitam o horário de verão. Perfis sem dono e relações de
concorrência não entram no Daily: o Watched usa a seleção de relações descrita abaixo. Nenhum
usuário é inferido do username, e nenhuma tabela User é criada.

Um job DAILY_PROFILE_SYNC registra a lista original e os membros ainda pendentes.
Essa lista também reserva os membros não primários contra outro Initial/Daily.
Transações serializáveis e locks por perfil protegem enqueues concorrentes. Se
um perfil perder o dono, o Daily antigo não bloqueia sua nova reserva/Initial.

O worker usa Profile Scraper com vários usernames do mesmo dono, depois Reel
Scraper para os Reels dos doze posts próprios mais recentes entre os retornados.
Posts fixados são ordenados por timestamp; ownerId deve corresponder ao perfil.
Views não vêm do Profile Scraper. Métricas indisponíveis ficam null, curtidas
ocultas são preservadas e posts mais antigos não recebem atualização automática.
Cada execução cria **um** ProviderRun com o custo real conhecido/null e o dono
do lote. Para lotes com vários perfis, instagramProfileId do run fica null; a
relação com os membros permanece no payload do job, sem rateio estimado.

Cada perfil é persistido em sua própria transação protegida pelo lease/token do
job: identidade, posts, snapshots, lastSyncedAt/ready e retirada da lista pendente
são atômicos. Isso limita o tamanho das transações e preserva perfis já concluídos
se outro perfil falhar. Uma conta privada ou ausente não impede a gravação das
outras contas válidas. As falhas individuais ficam registradas no job.

São três tentativas totais, com esperas de um e cinco minutos. Depois disso, os
perfis ainda pendentes ficam para o dia seguinte, preservando seu status/dados
anteriores. Retomada de lease não aumenta a tentativa e não refaz perfis já
concluídos. Runs conhecidos que cobrem os membros restantes são consultados de
novo; não se repete um POST de início incerto sem apifyRunId. Conteúdo inválido de
um run sucedido pode permanecer inválido nas releituras e encerrar as tentativas
sem outra cobrança de Actor. Payload inválido também tem retries limitados.

Snapshots de perfil do Daily e Watched são deduplicados pelo dia de Nova York.
Initial mantém o intervalo de vinte horas.
O fluxo HTTP legado profile/search mantém seu intervalo padrão anterior de 24h;
cache Discover e frescor de post continuam em 24h, sem mudança. Snapshots novos
de métricas do Daily usam source daily. Repetir a execução/reiniciar o worker não
regrava um membro já concluído. O Daily tem prioridade no ciclo do worker, que
ainda atende Initial, Post Refresh e Discover.

Os testes usam transporte Apify simulado; custo, cobertura real dos doze posts e
conclusão antes das 6h ainda dependem de validação autorizada. Nenhuma migration,
instalação de cron ou execução paga é necessária para estes testes.

## Watched Sync — contas acompanhadas apos o Daily

O mesmo cron de 4h de Nova York enfileira as contas acompanhadas depois dos
perfis proprios. O worker espera todos os Daily pendentes/em execucao terminarem,
incluindo retries futuros, antes de coletar Watched. Nao ha endpoint novo.
O resumo do cron acrescenta `watched` com total/queued/reused/notDue/failed/pending
e failures; qualquer enqueue incompleto retorna 503. Isso confirma enqueue,
nao que os dados ja foram atualizados.

Entram apenas relacoes ativas cujo **monitorador** tenha dono e prazo de
monitoramento vigente. O alvo pode nao ter dono. Relacoes encerradas e fontes
pausadas nao alimentam a coleta; historico permanece salvo. Os alvos sao
revalidados antes do Apify e da persistencia. Daily que ja tentou aquele alvo na
mesma data NY (mesmo com falha) impede uma segunda sequencia no Watched.

Cada alvo e coletado no maximo uma vez por dia de Nova York, usando snapshots
de seguidores em vez de lastSyncedAt para decidir se falta a contagem do dia. Os lotes usam
`INSTAGRAM_DAILY_BATCH_SIZE`, agrupados pelo usuario a quem o custo pertence.
Multiplos perfis do mesmo usuario nao duplicam custo. Se usuarios diferentes
acompanham o mesmo alvo, o custo e registrado uma vez com userId null e aparece
em `unattributedUsd`. A atribuicao e conferida antes de iniciar o Actor; se mudar,
o lote antigo descarta o membro e um cron posterior pode seleciona-lo novamente.
Uma execucao ja iniciada preserva sua atribuicao original.

A coleta usa o pipeline Daily: identidade, snapshot, ate doze posts proprios
mais recentes e views pelo Reel Scraper. Metricas usam `source: daily`; execucoes
usam `trigger: watched`. Tres tentativas totais (esperas de 1/5min), progresso por
membro, retomada de lease e reutilizacao de runs conhecidos preservam os sucessos
sem repetir inicios incertos. Campos desconhecidos continuam null.

Sem migration, nova variavel, Actor pago ou deploy nesta etapa. Para verificar
persistencia/concorrencia em schema temporario, com Apify simulada:

```bash
RUN_DATABASE_TESTS=true npx vitest run tests/instagram-watched.integration.test.ts
```

## Entrega e operação da MVP

Os 16 endpoints originais, a remoção de dono adicional e os cinco executores estão implementados. O inventário completo
fica em [docs/mvp-implementation-audit.md](docs/mvp-implementation-audit.md).
As buscas legadas de perfil, posts, trends e prévia de concorrente também
registram ProviderRun com o usuário autenticado, custo real conhecido/null e
falhas. Não há alteração nos seus DTOs ou criação de User.

Execuções com ID conhecido podem ter custos/estado conciliados após o build:

```bash
npm run costs:reconcile -- --limit 100
```

Use `--after ID` com nextCursor para continuar. O comando apenas consulta runs;
não inicia Actors. Inícios sem ID confirmado continuam como unresolvedStarts e
exigem conferência operacional, sem associação ou cobrança estimada. Dados de
custos de buscas antigas anteriores ao rastreamento não são inventados/backfill.

[deploy/README.md](deploy/README.md) contém serviços systemd separados para API e
worker, timer, cliente do cron e referência de proxy. São arquivos para revisão
e instalação na VPS, sem deploy efetuado. O timer consulta a API a cada dez
minutos e o servidor aceita apenas 4h–4h59 de Nova York; repetições são deduplicadas.
A sintaxe do calendário segue o [manual oficial do systemd](https://www.freedesktop.org/software/systemd/man/latest/systemd.time.html).

A entrega local não substitui a validação com o backend principal, domínio/TLS,
credenciais da VPS e Actors reais: cobertura de resultados, custo e conclusão
antes das 6h precisam ser medidos no ambiente de destino.

## Remover dono — endpoint adicional (25/11/2026)

```http
DELETE /api/v1/internal/instagram/profiles/ID_INTERNO/owner?userId=ID_DO_DONO_ATUAL
Authorization: Bearer <JWT_DE_SERVICO>
```

Sem body. Exige sub=hustleq-main e scope=service. Define ownerUserId=null,
encerra somente relações ativas que saem desse perfil e cancela jobs pendentes
de Initial Sync, Daily e Post Refresh. Nos lotes Daily, retira apenas esse membro;
os demais continuam. Jobs em execução não são abortados, e não há chamada ao
abort da Apify. Perfil, posts, snapshots, métricas e ledger permanecem salvos.
Relações em que outro perfil acompanha esse alvo não mudam.

204 sem corpo na remoção e em repetições quando já não houver dono; 409
OWNER_MISMATCH se outro usuário for dono; 404 PROFILE_NOT_FOUND; 400
INVALID_REQUEST para query inválida/body; 401/403 para autenticação. A comparação
do dono e as alterações são transacionais. Uma repetição quando já está sem dono
não cancela jobs de um novo convite nem limpa sua reserva.

Sem dono, o perfil sai do Daily. As leituras do antigo dono retornam 403 se ele
não tiver outra relação válida de COMPETITOR. Outros clientes que ainda
acompanham o alvo mantêm acesso e sua coleta Watched. O perfil pode ser reservado
e receber outro dono pelas rotas internas existentes, mantendo o mesmo ID.
Cancelamentos internos usam FAILED com lastError PROFILE_OWNER_REMOVED, sem
adicionar enum/tabela/migration.

Ao atribuir dono (POST .../owner), também atribui a esse usuário os ProviderRun
initial do perfil que ainda têm userId null, na mesma transação. Custos, datas e
usuários já atribuídos não são sobrescritos. Repetir o aceite pelo mesmo dono
aplica esse preenchimento aos registros anteriores. A remoção do dono não
apaga/reassocia cobranças históricas.

A busca de perfil grava usageTotalUsd real como Decimal, inclusive zero; ausência
fica null, nunca preço estimado. A conciliação também passa a revisar custos
zero, além de running/null. Executar no ambiente com acesso aos runs:

```bash
npm run costs:reconcile -- --limit 100
```

## Ambiente informado pelo backend principal

Em 25/11/2026, o usuário informou que o worker está no Railway, serviço
social-data-worker, usando npm run start:worker e INSTAGRAM_WORKER_ENABLED=true.
O backend chama /api/cron/instagram-refresh a cada dez minutos. API e worker são
serviços separados; o cliente loopback de deploy/ é referência para VPS, não o
agendador do Railway. Não instalar outro timer para duplicar o agendamento.
O fluxo de convite ponta a ponta foi validado pelo time, segundo o relato do
usuário. Não houve deploy nem acesso administrativo ao Railway nesta alteração.
