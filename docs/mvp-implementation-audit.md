# MVP — auditoria e memória de implementação

Referência: “Social Data API · Guia de implementação da MVP”, Nov 18, 2026,
@Iza, fornecido pelo usuário nesta conversa. Auditoria do código em 19/11/2026.
Prazo informado no guia: 23/11/2026. Este documento registra diferenças e
pendências; não representa autorização para implementar todas elas de uma vez.

## Como continuar o trabalho

- Perguntar ao usuário antes de criar cada etapa e esclarecer as regras abertas.
- Apresentar o que será alterado, testar o comportamento e pausar ao concluir
  cada etapa para o usuário revisar e fazer commit.
- Não criar tabela User. O guia usa IDs externos da HustleQ em ownerUserId e
  ProviderRun.userId. A identidade vem da autenticação, nunca de um body de negócio.
- Não mudar contratos, IDs existentes, tabelas ou agendamento silenciosamente.
- Não enviar mensagens ao time, publicar, fazer deploy ou executar Actors pagos
  como parte dos testes sem autorização para essas ações.
- O usuario confirmou seguir o guia: dois refreshes comerciais por conta no
  backend principal; nesta API, teto configuravel padrao dez por usuario/dia UTC.
  Tarefas manuais aceitas contam mesmo com falha (etapa O).
- Variáveis de ambiente configuram limites; a contagem precisa ser persistida
  e protegida contra concorrência. Uma variável em memória não atende a múltiplas
  instancias/reinicios da aplicacao.

## Resultado da comparação

Situacao atualizada em 24/11/2026: os 16 endpoints estao implementados no
codigo, assim como os cinco executores (Initial, Daily, Watched, Post Refresh e
Discover). As oito tabelas (sete do guia e a fila InstagramSyncJob autorizada)
estao modeladas, com migrations aplicadas no Supabase de desenvolvimento.
Isso ainda nao equivale a integracao/deploy concluido: faltam validar os Actors,
o adaptador do backend, custos/SLA reais e a operacao na VPS.

## Funcionalidades - acompanhamento atual

| Funcionalidade                          | Situacao                                             | O que falta                                   |
| --------------------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| Tabelas, IDs String e migrations        | Prontas no desenvolvimento                           | Alinhar CUID com o consumidor                 |
| JWT, OWNER/COMPETITOR e token service   | Prontos nas rotas MVP                                | Integracao externa                            |
| Convites, reserva, dono e monitoramento | Endpoints 1–5/11 implementados                       | Validacao externa de contrato/SLA             |
| Leituras de posts e historico           | Endpoints 6–9 implementados                          | Validar adaptador                             |
| Fila duravel e cinco executores         | Implementados                                        | Operacao API/worker/scheduler na VPS          |
| Coleta diaria propria e acompanhada     | Daily (Q) e Watched (R), 12 posts e intervalo 20h    | Actors/SLA/custo reais                        |
| Contas acompanhadas                     | Endpoints 13–15 e sincronizacao implementados        | Integracao externa                            |
| Post Refresh                            | Fila, retries, deduplicacao e teto UTC               | Benchmark dos Actors e deploy                 |
| Custos Apify                            | Ledger MVP/legado e conciliacao manual implementados | Conferencia de inicios sem ID e cobranca real |
| Discover                                | Endpoint 16, cache 24h e executor                    | Aquecimento pelo backend e validacao externa  |
| Deploy e integracao                     | VPS confirmada                                       | Configurar e validar com o backend principal  |

## Inventário dos 16 endpoints

Os caminhos do guia não incluem o prefixo. Hoje as rotas de negócio usam
`/api/v1`; confirmar esse prefixo com o backend principal. As rotas legadas
usam `{ response: ... }`; as novas leituras 5-7 retornam objetos diretos como no guia.

| #   | Endpoint do guia                                                | Situação no código                                                     | Trabalho pendente                                                      |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | GET /instagram/profiles/search                                  | Pronto no codigo: previa sem cadastro/reserva, ownership e ProviderRun | Validar contrato/SLA/custo reais e migrar consumidor legado            |
| 2   | POST /internal/instagram/profiles                               | Pronto no codigo: reserva + lookup reaproveitado + Initial Sync        | Validacao externa de contrato, SLA e cobranca                          |
| 3   | POST /internal/instagram/profiles/:profileId/owner              | Pronto nesta etapa                                                     | Validacao externa com o backend principal                              |
| 4   | DELETE /internal/instagram/profiles/:profileId/reservation      | Pronto nesta etapa                                                     | Validacao externa com o backend principal                              |
| 5   | GET /instagram/profiles/:profileId                              | Pronto nesta etapa                                                     | Validacao externa; isVerified pode ser null por decisao do usuario     |
| 6   | GET /instagram/profiles/:profileId/posts                        | Pronto nesta etapa                                                     | Validacao externa com o adaptador                                      |
| 7   | GET /instagram/profiles/:profileId/snapshots                    | Pronto nesta etapa                                                     | Validacao externa com o adaptador                                      |
| 8   | GET /instagram/posts/:postId                                    | Pronto: 200/202, frescor 24h e on_open duravel                         | Validacao externa e worker no deploy                                   |
| 9   | GET /instagram/posts/:postId/metrics                            | Pronto nesta etapa                                                     | Validacao externa com o adaptador                                      |
| 10  | POST /instagram/posts/:postId/refresh                           | Pronto: fila, deduplicacao, teto diario UTC e snapshot                 | Validacao externa e worker no deploy                                   |
| 11  | PATCH /internal/instagram/profiles/:profileId/monitoring        | Pronto nesta etapa                                                     | Elegibilidade aplicada a Daily e Watched; validar integracao externa   |
| 12  | GET /internal/costs                                             | Pronto: mes UTC, agrupamentos e totais anulaveis                       | Ledger/conciliacao implementados; validar cobranca externa             |
| 13  | GET /instagram/profiles/:profileId/competitors                  | Pronto: dono, listagem no envelope existente                           | Validacao externa com o adaptador                                      |
| 14  | POST /instagram/profiles/:profileId/competitors                 | Pronto: username, regras e Initial Sync atomico                        | Worker habilitado no deploy e validacao externa                        |
| 15  | DELETE /instagram/profiles/:profileId/competitors/:competitorId | Pronto: ID da relacao, dono, 204, historico preservado                 | Validacao externa; Watched diario implementado na etapa R              |
| 16  | GET /instagram/discover                                         | Pronto: nicho/cidade/query, cache 24h, 200 aguardando worker e custos  | Validacao externa, timeout do backend/proxy e aquecimento pelo backend |

O usuario aprovou na etapa M substituir o comprovante de confirmacao por body
username, manter competitorId como ID da relacao e preservar o envelope da
listagem. A previa de confirmacao passa pelo GET do endpoint 1.

## Autenticacao e erros - estado atual

JWT HS256 com iss/aud configuraveis e sub/iat/exp obrigatorios, duracao maxima
de cinco minutos e guards separados de usuario/servico estao implementados.
OWNER/COMPETITOR ja e calculado pelo banco nos endpoints 5-7 e 9. O guard de servico
exige sub=hustleq-main e scope=service; os endpoints internos 3/4 ja usam esse guard.
ownerUserId e atribuido explicitamente pelo endpoint interno 3, nunca por efeito de um GET.

- O backend principal e o unico cliente. Nao criar login publico nem tabela User.
- Leituras 5-7 e 9 usam o sub do JWT, sem confiar em claims OWNER/COMPETITOR, body ou
  query para decidir acesso. Perfis sem dono/relacao autorizada retornam 403.
- Outras rotas ainda precisam ser criadas ou migradas para a autorizacao da MVP.
- Erros de negocio usam error/code/message/time, UNAUTHENTICATED, FORBIDDEN,
  INVALID_REQUEST, RATE_LIMITED e PROVIDER_UNAVAILABLE, com falhas internas
  sanitizadas. O cron legado mantem seu contrato anterior ate a migracao dos jobs.
- Search inexistente continua 404 no legado; o GET novo do endpoint 1 usa 200
  com ownershipStatus=not_found. Perfil privado preserva 404 PROFILE_PRIVATE,
  conforme o contrato ja aprovado. Falha operacional nunca vira inexistente.
- Discover aceita aquecimento com token service; o agendamento desse aquecimento pertence ao backend principal.

## Banco - oito tabelas aplicadas ao desenvolvimento

| Tabela                      | Estado atual                                                                   | Pendente                                                 |
| --------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| InstagramProfile            | Identidade e fluxos de reserva/dono/monitoramento; Initial Sync                | Elegibilidade/atualizacao Daily e Watched implementadas  |
| InstagramProfileSnapshot    | Jobs Initial/Daily com intervalo minimo de 20h; legado HTTP 24h                | Validacao externa e historico diario em producao         |
| InstagramCompetitor         | Relacao, endedAt, historico e limite de tres ativos; endpoints 13–15           | Watched Sync implementado; validar integracao externa    |
| InstagramPost               | Conteudo, lastCollectedAt e frescor 200/202 nos endpoints 6/8                  | Daily/Watched implementados; validar Actors reais        |
| InstagramPostMetricSnapshot | Historico imutavel; source initial/on_open/refresh, views BigInt e likesHidden | source daily nos jobs; validacao real pendente           |
| DiscoverCache               | Endpoint, chave normalizada, TTL 24h e coordenacao de buscas                   | Validacao externa e operacao no deploy                   |
| ProviderRun                 | MVP e legado com custo conhecido/null, usuario, estado e conciliacao manual    | MVP/legado rastreados; inicios sem ID exigem conferencia |
| InstagramSyncJob            | Fila e worker Initial com retomada de lease e ids Apify persistidos            | Enqueue pelos endpoints MVP e demais executores          |

Decisoes preservadas: IDs internos String/cuid(), sem conversao para UUID;
FKs anteriores com Restrict; contagens e isVerified desconhecidos podem ser null.
Datas de coleta novas nao receberam backfill no legado. Source antigo fica null,
com novas gravacoes initial/daily; on_open/refresh dependem dos jobs. Nao ha User.

Views BigInt sao convertidas nas leituras novas apenas dentro da faixa segura
do JSON Number; valores maiores geram erro sem arredondamento. Os proximos jobs
precisam implementar transicoes de status e trava duravel: apenas consultar
ProviderRun e depois criar uma linha nao impede execucoes concorrentes.

## Jobs: base atual e lacunas

| Job                  | Base existente                                                                           | Pendências                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Initial Profile Sync | Worker com 12 posts retornados/Reel Scraper/custos/retomada; endpoints 2 e 14 enfileiram | Lotes e validar SLA/cobranca reais                                             |
| Daily Profile Sync   | Cron enfileira às 4h NY; lotes por dono, 12 posts, Reel Scraper, 20h, custos e retries   | Validacao PostgreSQL em schema isolado passou; faltam custo/SLA reais e deploy |
| Watched Sync         | Etapa R: relacoes ativas elegiveis, depois do Daily, lotes por atribuicao, 20h e retries | Validacao de Actors/SLA/custo reais e deploy                                   |
| Post Refresh         | Executor duravel ligado aos endpoints 8/10; source, custos, retries e lease              | Benchmark real dos Actors, deploy e integracao externa                         |
| Discover Search      | Worker Seemu, 50 posts/30 dias, cache, fromCache, custos, retries e fencing              | Validacao real, deploy e aquecimento pelo backend                              |

Estado atual: API e worker sao processos separados na VPS, com tarefas
persistidas no PostgreSQL e fencing de lease/token. O cron apenas enfileira,
com trava local auxiliar e transacoes serializaveis para concorrencia entre
processos. Os jobs tem tres tentativas totais (esperas de 1/5min) e retomada de
runs conhecidos. Nao ha Promise solta executando Actor depois do HTTP.

Decisoes confirmadas: iniciar o Daily as 4h America/New_York e usar intervalo
minimo de vinte horas para snapshots automaticos Initial/Daily/Watched; legado
HTTP continua com 24h. Watched espera o Daily, inclusive retries futuros. A meta
de terminar antes das 6h ainda exige medicao real. Nenhum deploy ou agendamento
foi instalado na VPS. O backend principal no Railway e um servico separado.

## Refresh manual: decisoes confirmadas na etapa O

- Seguir o guia: dois por conta no backend principal; nesta API, apenas teto de
  seguranca por usuario, configuravel e padrao dez.
- O usuario definiu reinicio a meia-noite UTC. Uma tarefa manual aceita conta
  mesmo se falhar. Retry da tarefa e reutilizacao de job ativo nao gastam outra
  unidade; on_open nao conta.
- A contagem vem de InstagramSyncJob, preservando historico, sem tabela nova.
  A transacao usa lock por usuario para cota e lock por post para enqueue.
- Os endpoints 8/10 operam apenas sobre um post salvo, com escopo OWNER ou
  COMPETITOR. Nenhuma atualizacao de perfil adicional foi criada.
- Compete ao backend principal acompanhar a cota comercial e decidir seu
  tratamento quando a coleta falhar; o teto de seguranca local nao e reembolsado.

## Normalização: diagnóstico inicial e correções nas etapas C/D

O diagnóstico inicial abaixo é de 19/11/2026; as correções entregues estão
registradas nas etapas C/D e na tabela atual de funcionalidades.

Já existe normalização compartilhada de tipos, exclusão de hashtags sem letras,
IDs externos string, métricas desconhecidas null e proteção contra troca de autor.

Pendências e divergências:

- Tipo atual: photo/carousel/reel. Guia: IMAGE/CAROUSEL/REEL. Pode ser mapeado na
  fronteira HTTP sem trocar o enum do banco; depende do contrato acordado.
- Usernames devem ser minúsculos e sem @ em todas as entradas/saídas. A prévia
  de concorrentes remove @, mas não há normalização global em minúsculas.
- Hashtags já removem # e duplicatas exatas, mas não usam minúsculas; adaptar
  sem reintroduzir hashtags só numéricas e com teste de maiúsculas/Unicode.
- likesCount=-1 é rejeitado na persistência atual. Precisa virar null com
  likesHidden=true; distinguir desconhecido de oculto e testar os Actors.
- Views confiáveis de Reels exigem Reel Scraper, ainda não integrado. Dados de
  Profile Scraper hoje podem ser usados como views; o guia não autoriza isso.
  Em fotos/carrosséis, views deve ficar null.
- A prévia de concorrentes usa fallback profilePicUrlHD → profilePicUrl, mas a
  persistência normal de perfil usa somente HD. Uniformizar o fallback.
- Carrossel precisa preservar todas as imagens em ordem; conferir os retornos
  reais e childPosts. Não tratar a capa como se fossem todas as imagens.
- Post sem URL pode montar URL com shortCode válido; sem dados suficientes,
  não fabricar identificadores, data ou métricas.
- name vazio deve virar null. Não substituir bio por texto inventado.
- Leituras de posts do banco devem ordenar por timestamp, sem depender da
  ordem de fixação do Instagram.

## Discover e custos

Trends continua sem persistência conforme decisão anterior. Discover com cache
é um contrato novo pedido pelo guia, não uma autorização para começar a salvar
resultados de trends/search ou criar posts/perfis a partir deles.

O filtro legado de trends exige 1000 likes quando não há localização. O guia
do Discover não define esse filtro. Não reaplicá-lo silenciosamente: ele pode
descartar posts que o feed da MVP precisa mostrar.

Cache compartilhado: normalizar caixa, acentos e espaços; tratar componente
vazio de forma consistente e evitar colisões de delimitadores na chave.
Coordenar misses simultâneos para evitar Actors/custos duplicados. Validar TTL
de 24h, fromCache e comportamento quando provider falha com cache antigo.
Cache não é uma garantia de relevância geográfica ou de cobertura do Instagram.

ProviderRun deve registrar cada execução real, inclusive falhas, e custo
usageTotalUsd quando disponível. Campo de custo ausente não significa zero.
Definir moeda/precisão, mês/fuso do relatório, execuções que cruzam o mês e
atribuição de custo em lotes/perfis compartilhados. Não cobrar uma mesma execução
integralmente de vários usuários nem apresentar estimativa como custo real.

## Ordem proposta, sujeita a confirmação em cada etapa

1. Alinhar contrato novo/compatibilidade, IDs e responsabilidades de limites.
2. Autenticação usuário/serviço e formato de erros, com testes de 401/403.
3. Modelagem incremental das sete tabelas, estratégia de backfill e migration.
4. Normalização e fixtures sanitizadas de respostas reais, incluindo likes ocultos,
   carrosséis e views de Reels. Não iniciar Actors pagos só para criar fixtures.
5. Escolher mecanismo durável de jobs; ProviderRun/travas/custos e Initial Sync.
6. Convites/reservas/dono e leitura de perfil: endpoints 2–5.
7. Posts e snapshots: endpoints 6–7; Daily de 12 posts e elegibilidade/horário.
8. Post Refresh e históricos: endpoints 8–10, frescor, quota e concorrência.
9. Busca sem persistir com ownershipStatus, monitoring e custos: 1, 11 e 12.
10. Adaptar Watched e seu Sync; Discover/cache: 13–16.
11. Validar o adaptador do backend principal e Swagger no ambiente acordado;
    testes de integração de dois dias e custos. Deploy depende de autorização.

## Testes a acrescentar nas etapas correspondentes

- Fixtures por Actor e contratos HTTP exatos com o adaptador; garantir que leituras
  comuns não invoquem Apify e não exponham ownerUserId.
- OWNER, COMPETITOR ativo, relação encerrada, acesso cruzado, usuário sem dono,
  scope service, claims temporais e rejeição de internal sem escopo.
- Reservas concorrentes, expiração, reenvio do mesmo convite, idempotência de
  atribuição de dono e liberação sem perda de histórico.
- Job já em andamento, janela de dez minutos, recuperação de execução abandonada,
  retry e rollback sem snapshot falso ou coleta duplicada.
- Frescor imediatamente antes/no/depois de 24h; snapshot automático conforme
  a janela final escolhida, posições 11/12/13 e posts fixados.
- Duas chamadas manuais simultâneas, limite atingido, meia-noite/fuso/horário de
  verão, falha sem desconto comercial e on_open sem quota manual.
- Cache com menos de/exatamente/mais de 24h, equivalência de chave, misses
  concorrentes, aquecimento service e falha do provider.
- Custo ausente, Decimal, falha paga, mês, atribuição e lote compartilhado.
- Reexecutar npm test, typecheck, lint, format:check e build após mudanças de código.
  Não interpretar testes mockados como comprovação de SLA, preço ou cobertura.

## Decisões confirmadas após a auditoria

1. Seguir o guia como contrato de destino da MVP. As rotas legadas ficam
   temporariamente durante a implementação das substitutas; isso não as torna
   compatíveis com a MVP. Nenhuma substituição foi implementada nesta auditoria.
2. Seguir o guia: limite comercial de dois por conta no backend principal e teto
   de segurança configurável de dez por usuário nesta API. Reset diário; fuso
   do teto e persistência da contagem serão esclarecidos na etapa de refresh.
3. Manter IDs internos atuais como strings CUID. O usuário alinhará com o time
   a diferença em relação ao UUID mencionado no guia. Não migrar IDs existentes.

As demais perguntas acima devem ser apresentadas antes de implementar a etapa
afetada; não considerar silêncio como aprovação. Atualizar este documento com
as respostas e evidências de conclusão ao longo do trabalho.

## Etapa posterior A — autenticação e erros

Implementado nesta etapa:

- Tokens de acesso com iat/sub/exp, HS256, iss/aud e validade máxima de 300s.
  Emissão local com cinco minutos; tokens antigos de uma hora precisam ser renovados.
- Guards separados de usuário e serviço. Serviço exige sub=hustleq-main e
  scope=service; usuário não pode declarar escopo de serviço/OWNER/COMPETITOR.
- Erros de negócio no envelope error/code/message/time, validação INVALID_REQUEST,
  autenticação UNAUTHENTICATED, papel FORBIDDEN, provider RATE_LIMITED ou
  PROVIDER_UNAVAILABLE. Falhas internas retornam INTERNAL_ERROR sem detalhes.
- Helpers de leitura de perfil/post calculam OWNER/COMPETITOR pelo banco e
  consultam somente relações ativas pertencentes a perfis do usuário autenticado.
- Helpers de acesso ainda não ligados a endpoints: as leituras MVP e as rotas
  internal serão construídas nas próximas etapas. Não afirmar que as rotas
  legadas já verificam propriedade. O cron legado mantém seu contrato anterior.

Não houve migration, alteração de quota, disparo Apify ou deploy nesta etapa.
Os inventários acima representam a auditoria inicial; esta seção registra o
progresso posterior. Validação concluída: 268 testes passaram; typecheck, lint,
format:check e build passaram. Os testes novos usam provider/banco simulados;
não comprovam desempenho ou integração em produção.

## Etapa posterior B — modelagem e migration MVP

Decisão do usuário: manter source = null nos snapshots já existentes, pois eram
coletas de teste. Os registros são preservados, sem atribuir uma origem inventada.
Novas gravações dos repositories existentes passam a informar initial ou daily.

Schema ampliado para sete modelos, com campos de reserva/monitoramento/sync,
lastCollectedAt, likesHidden/source, DiscoverCache e ProviderRun. Todos os IDs
continuam String/cuid(), contagens desconhecidas continuam null, viewsCount
continua BigInt e as FKs anteriores continuam Restrict. Datas novas no legado
não recebem backfill; syncStatus começa pending. Não há tabela User.

A migration é aditiva. lastCollectedAt passa a acompanhar somente a gravação de
métricas, não atualizações isoladas de conteúdo. A nova modelagem ainda não cria
rotas, cache, custos, controle de quota, jobs ou enriquecimento pelo Reel Scraper.
O cron simples, seu horário e o limite de dez posts não foram alterados.

Validação concluída: 270 testes locais passaram; o teste PostgreSQL opt-in passou
separadamente e confirmou o rollback do schema isolado. Prisma validate/generate,
typecheck, lint, format:check e build passaram. A migration foi aplicada ao
Supabase de desenvolvimento após validação. Prisma migrate diff não detectou
diferença entre banco e schema versionado. Verificação final: dois perfis,
14 posts, 14 snapshots de métricas (todos com source null), DiscoverCache e
ProviderRun vazios. Nenhuma coleta Apify foi executada. O teste opt-in fica
ignorado por padrão no npm test para não acessar o banco automaticamente.

## Etapa posterior C — normalização e fixtures

Implementado:

- Schema de retorno compartilhado entre perfil/post e normalizador independente
  da origem profile/post/reel. IDs string; contagens validadas, incluindo -1
  somente para curtidas ocultas. Inteiros imprecisos e frações são rejeitados.
- likesCount=-1 vira null + likesHidden=true; ausência não implica curtida oculta.
  Repositories gravam likesHidden no snapshot, sem espalhá-lo no conteúdo do post.
- Usernames minúsculos sem @, hashtags minúsculas/deduplicadas com Unicode e
  descarte de hashtags sem letras. Nome vazio null e foto HD com fallback.
- Imagens de carrossel preservam ordem; fallback por childPosts quando a lista
  principal está vazia. Capa sem detalhes não finge representar todo o carrossel.
  URL pode ser construída com shortCode válido; campos desconhecidos ficam null.
- Tipos internos e legados continuam photo/carousel/reel. Mapper dos novos DTOs
  preparado para IMAGE/CAROUSEL/REEL. productType clips identifica Reel.
- Views de novas coletas de Profile/Post Scraper ficam null. Somente o retorno
  explicitamente identificado como Reel Scraper é normalizado como fonte de views,
  priorizando videoPlayCount e preservando zero. Não há Actor extra ligado às
  rotas legadas; o enriquecimento ainda depende dos jobs.
- Fixtures sanitizadas/adaptadas dos exemplos fornecidos pelo usuário e do exemplo
  público oficial do Reel Scraper, com origem explícita em cada JSON. São amostras
  de contrato, não comprovação de execução real nem fixtures de uma nova coleta.

Nenhuma migration, quota, cron ou novo endpoint nesta etapa. Sem Actors pagos,
sem deploy e sem alteração dos dados históricos do schema public. A integração
com Reel Scraper, travas/custos e execução durável continuam pendentes.

Validação concluída: 301 testes locais passaram, e o teste PostgreSQL opt-in
passou separadamente com rollback confirmado do schema de teste. Typecheck, lint,
format:check e build passaram. O teste real gravou um snapshot com curtidas ocultas
e depois outro com curtidas públicas, preservando o histórico e source do legado.
A execução paralela de ferramentas apresentou timeouts em testes de rota; a suíte
passou isoladamente, sem aumentar timeouts nem modificar a configuração de testes.
Não usar duração de testes mockados como evidência de SLA do Apify.

## Etapa posterior D — leituras de perfil, posts e snapshots (5–7)

Decisões: isVerified permanece null quando desconhecido, por confirmação do
usuário; não converter ausência em false. Continuar atualizando as tabelas de
funcionalidades e dos 16 endpoints ao concluir cada funcionalidade.

Implementado com routes, schemas, service e repository:

- GET /api/v1/instagram/profiles/:profileId: identidade salva, syncStatus,
  lastSyncedAt e snapshot mais recente; metrics null se ainda não coletado.
- GET /api/v1/instagram/profiles/:profileId/posts: filtros por data de publicação
  e tipo IMAGE/CAROUSEL/REEL, page=1, limit=30 (máximo 50), total/totalPages e
  métrica mais recente de cada post. Ordenação por timestamp desc, nulos no fim
  e desempate estável por ID. Página além do total retorna lista vazia.
- GET /api/v1/instagram/profiles/:profileId/snapshots: collectedAt crescente,
  filtros from/to, sem paginação, sem criar dias ou números ausentes.
- Autenticação de usuário e escopo OWNER/COMPETITOR consultado na mesma transação
  RepeatableRead dos dados. Relação deve estar ativa e partir de um perfil
  pertencente ao usuário do JWT. Token de serviço não acessa essas rotas.
- Nenhuma chamada Apify, Actor, escrita ou coleta em resposta a esses GETs.
  Dados antigos continuam sendo devolvidos; jobs futuros atualizarão a origem.
- Datas simples YYYY-MM-DD incluem o dia inteiro em UTC; instantes ISO têm
  limites inclusivos, com suporte a offset. Intervalo invertido é 400.
- Dados desconhecidos ficam null; métricas ausentes ficam metrics=null. Views
  somente de REEL, BigInt convertido sem arredondar para Number seguro do JSON.
  Valor fora da faixa segura gera INTERNAL_ERROR, não um número inventado.
- Selects e schemas limitam o contrato, sem expor ownerUserId, reservas ou
  informações internas de execução. Identidade/hashtags legadas são normalizadas
  apenas no retorno, sem sobrescrever o histórico no banco.

A atribuição de ownerUserId ainda depende do endpoint interno 3 (ou preparação
manual de dados de desenvolvimento pelo responsável). Perfis legados sem dono
nem relação ativa não ficam públicos; retornam 403. Não atribuir dono como efeito
colateral de uma leitura nem afrouxar autorização para facilitar demonstração.

Não houve migration, mudança de cron, quota ou deploy nesta etapa.
Validacao concluida: 355 testes locais passaram; o teste PostgreSQL opt-in
passou separadamente, incluindo acesso por dono/relacao ativa, bloqueio apos
encerramento, filtros, paginacao e preservacao do historico. O schema isolado foi
revertido e sua ausencia foi confirmada. Typecheck, lint, format:check e build
passaram. Nenhuma execucao Apify foi iniciada, nem dados do schema public foram
alterados. Pausar para o commit do usuario antes da proxima etapa.

## Etapa posterior E — atribuir dono e liberar reserva (3–4)

Implementado com routes, schemas, service e repository:

- POST /api/v1/internal/instagram/profiles/:profileId/owner recebe userId String,
  atribui ownerUserId e limpa reservedForInviteId/reservedUntil. Retorna 200 com
  profileId/ownerUserId. Mesmo dono é idempotente; dono diferente gera 409
  PROFILE_ALREADY_OWNED sem alterar a reserva ou transferir o perfil.
- DELETE /api/v1/internal/instagram/profiles/:profileId/reservation limpa somente
  os campos da reserva e retorna 204 sem corpo. Preserva dono, dados e histórico.
  Repetição sem reserva é permitida. Perfil inexistente retorna 404 nas duas rotas.
- Guard real de serviço, com sub=hustleq-main e scope=service. Usuários comuns
  recebem 403; autenticação ausente/inválida recebe 401 antes de acessar o banco.
- Transação serializável com até três tentativas para P2034, revalidando o dono.
  Testes simulam conflitos e falhas sem expor SQL/credenciais no corpo do erro.
- O serviço principal é responsável por validar convite/aceite e o destinatário.
  userId no body interno é o usuário que receberá o perfil, não a identidade do
  chamador. Não aplicar essa exceção às rotas de usuário: nelas a identidade
  continua vindo do sub do JWT. Não há tabela User nesta API.

Não altera perfil/Instagram ID, contagens, posts ou snapshots; não faz coleta,
sync, migration, cron ou deploy. O endpoint 2 e Initial Sync continuam pendentes.
Este avanço permite usar as leituras 5–7 após a atribuição pelo backend, sem
editar ownerUserId manualmente. Não atribuir dono como efeito colateral de GETs.

Validacao concluida: 388 testes locais passaram. O teste PostgreSQL opt-in
passou separadamente, verificando atribuicao idempotente, conflito de outro dono,
limpeza de reserva e preservacao de posts/metricas, com rollback e ausencia do
schema temporario confirmados. Conflitos concorrentes foram simulados nos testes
de retry; nao se afirma teste de carga ou concorrencia real entre conexoes.
Typecheck, lint, format:check e build passaram.

O cenario opt-in chegou ao limite anterior de 45s durante as varias operacoes e
DDL de preparacao. Seu limite foi ampliado para 75s (90s no teste completo), com
verificacao de limpeza em finally tambem em falhas. O tempo das transacoes da
API permanece 15s; nenhuma configuracao de producao foi ampliada. A repeticao
real passou em aproximadamente 26s. Nao houve alteracao dos dados do schema
public, chamada Apify, migration ou deploy. Pausar para o commit do usuario.

## Etapa posterior F — historico de metricas dos posts (9)

Implementado com routes, schemas, service e repository:

- GET /api/v1/instagram/posts/:postId/metrics recebe o ID interno String do post,
  devolvido pelo endpoint 6; nao recebe o instagramPostId externo.
- Resposta direta com postId e metrics em collectedAt crescente, desempate por ID.
  Filtros opcionais from/to na data da coleta, sem paginacao. Data simples inclui
  o dia UTC inteiro; instante ISO tem limite inclusivo. Intervalo invalido e 400.
- Usuario do JWT e acesso OWNER/COMPETITOR ativo conferidos na mesma transacao
  RepeatableRead dos dados. Token de servico nao acessa essa rota. Post inexistente
  e 404 POST_NOT_FOUND; post sem historico no intervalo e 200 com metrics vazio.
- Historico inclui likesCount, likesHidden, commentsCount, viewsCount, collectedAt
  e source. Legado mantem source null; origens conhecidas initial/daily/on_open/refresh.
  Jobs on_open/refresh ainda nao existem: o contrato nao significa coleta implementada.
- Curtidas ocultas, zero, contagens desconhecidas e views somente de Reels seguem
  a mesma conversao usada pela listagem de posts, agora compartilhada. BigInt fora
  da faixa segura gera erro, sem arredondar. Nao ha agregacao ou metrica derivada.
- Nao chama Apify, nao inicia refresh e nao altera o banco, mesmo com dados antigos.
  Falhas de banco nao viram lista vazia. Sem migration, mudanca de cron ou deploy.

Estado: 6 endpoints prontos (3, 4, 5, 6, 7, 9), 4 parciais (1, 13, 14, 15)
e 6 pendentes (2, 8, 10, 11, 12, 16). Pausar para o commit do usuario.

Validacao concluida: 420 testes locais passaram, incluindo 32 novos testes de
rota/contrato, autenticacao, acesso, datas, historico vazio, null/zero, curtidas
ocultas e falhas. O teste PostgreSQL opt-in passou separadamente em cerca de 57s,
com historico real, filtros, source legado, views BigInt, acesso por dono e
relacao ativa e bloqueio apos encerramento. Rollback e ausencia do schema
isolado confirmados. Typecheck, lint, format:check e build passaram. Nenhuma
execucao Apify ou alteracao de dados publicos foi realizada.

## Etapa posterior G — prazo de monitoramento (11)

Autorizado pelo usuario: implementar PATCH de monitoring e aplicar seu filtro ao
cron existente, mantendo horario e demais criterios para a etapa dos jobs.

- PATCH /api/v1/internal/instagram/profiles/:profileId/monitoring exige token de
  servico. Body estrito com monitoringUntil ISO (Z/offset) ou null, obrigatorio.
  Nao aceita alterar dono, reserva, syncStatus ou outros campos pelo mesmo body.
- Retorna 200 com identidade normalizada do perfil, syncStatus, lastSyncedAt e
  monitoringUntil em UTC, sem dono/reserva/snapshots. IsVerified desconhecido null.
  Perfil inexistente e 404 PROFILE_NOT_FOUND. Usuario comum e 403.
- Somente monitoringUntil e atualizado (alem do updatedAt automatico do Prisma).
  Transacao serializavel e retry de conflito seguem a infraestrutura interna.
  Nao coleta, nao apaga dados e nao altera autorizacao de leitura.
- Cron seleciona monitoringUntil null ou estritamente maior que o instante da
  selecao. Igualdade ja e vencimento; null retoma elegibilidade da proxima coleta.
  O backend principal calcula os 30 dias: esta API nao soma prazo implicitamente.
- Filtro aplicado ao selecionar o lote; nao cancela trabalhos ja iniciados ou
  selecionados antes da alteracao. Horario continua 6h Nova York. Dono/relacoes
  ativas, 12 posts, 4h e jobs duraveis continuam para a etapa Daily/Watched.
- Campo ja existia: sem migration, chamada Apify ou deploy nesta etapa.

Estado: 7 endpoints prontos (3, 4, 5, 6, 7, 9, 11), 4 parciais (1, 13, 14, 15)
e 5 pendentes (2, 8, 10, 12, 16). Tabelas do inventario atualizadas. Pausar para
o commit do usuario ao concluir os testes.

Validacao concluida: 446 testes locais passaram (26 novos para monitoring),
com autenticacao, body estrito, offset UTC, data passada, null, idempotencia,
reserva/dono preservados, falhas sanitizadas e retries de transacao. Typecheck,
lint, format:check e build passaram. O teste PostgreSQL opt-in passou em cerca
de 38s, comprovando data futura elegivel, exclusao no instante exato/depois do
vencimento e retomada com null, junto das verificacoes anteriores. Rollback e
ausencia do schema temporario confirmados; nenhum dado do schema public foi
alterado. Nenhum Actor foi executado.

## Etapa posterior H — estrutura da fila interna na VPS

Decisao de 23/11/2026: hospedagem na VPS e autorizacao explicita para adicionar
InstagramSyncJob como oitava tabela, alem das sete do guia. E uma implementacao
interna dos cinco jobs exigidos; nao existe nem foi criado endpoint publico de
fila. ProviderRun continua separado, com uma linha por execucao real do Actor.

Preparado nesta etapa:

- Modelo InstagramSyncJob com IDs String/cuid e enums de tipo (Initial, Daily,
  Watched, Post Refresh e Discover) e estado PENDING/RUNNING/SUCCEEDED/FAILED.
- Referencias opcionais aos IDs internos de perfil/post, com FK Restrict para
  preservar historico. UserId externo continua String sem tabela User.
- Origem trigger, payload JSON opcional (sem credenciais), attempts, runAt,
  lockedAt, leaseExpiresAt, lockToken, lastError, finishedAt e datas de auditoria.
  Politica de limite/esperas das tentativas sera definida no worker, nao pelo schema.
- activeKey unica e obrigatoria para jobs pendentes/em execucao; na conclusao
  deve ficar null para permitir outra coleta, preservando o job antigo. A chave
  deve ser construida de forma consistente pelo futuro enqueue: o indice sozinho
  nao descobre que chaves diferentes representam o mesmo recurso.
- Constraints SQL rejeitam contador negativo, chave vazia, RUNNING sem posse/
  prazo valido e conclusao sem finishedAt ou com chave/posse ainda preenchidas.
  Tambem conferem alvo compativel com o tipo. Estes CHECKs estao na migration SQL,
  pois o schema Prisma nao os representa; nao descarta-los em migrations futuras.
- Indices para fila por estado/data, leases vencidos e historico por perfil/post.
- Migration aditiva 20261123000000_add_instagram_sync_jobs. Nenhuma tabela ou
  dado existente e removido. Nenhum job e criado automaticamente pelo schema.

Nao ha enqueue, claim atomico, heartbeat, retomada, retries ou worker nesta etapa.
O lockToken e o prazo sao apenas a estrutura: o futuro worker precisara validar
posse em cada transicao e tratar o Actor em andamento antes de repetir uma chamada.
Nao prometer exactly-once para chamadas externas com base nesses campos.

Os endpoints continuam 7 prontos, 4 parciais e 5 pendentes, conforme inventario.
A migration sera aplicada ao desenvolvimento depois da revisao/commit desta etapa;
nao executar migrate deploy ao iniciar uma rota. Pausar para o commit do usuario.

Validacao da etapa H: Prisma validate/generate, typecheck, lint, format:check,
build e 446 testes locais passaram (os dois testes de banco ficam opt-in).
O novo teste PostgreSQL passou separadamente em cerca de 33s, verificando oito
tabelas, preservacao de dados/IDs/metricas/custos, defaults, todos os tipos de job,
payload, chaves duplicadas, estados/posse invalidos, contador negativo, FK/alvo,
liberacao da chave apos conclusao e coexistencia de jobs finalizados. O teste
faz transicoes sequenciais: nao comprova claim concorrente nem recuperacao real
de worker. Rollback e ausencia do schema temporario confirmados. Nenhuma execucao
Apify, deploy ou alteracao do schema public ocorreu. Migration pendente de aplicacao.

## Etapa posterior I — migration aplicada e operacoes atomicas da fila

Decisao do usuario: tres tentativas no total (inicial, apos 1 minuto e apos mais
5 minutos). A referencia do guia a espera de 15 minutos nao e usada; nao ha
quarta tentativa automatica. Esta regra vale para o job; ProviderRun continuara
registrando cada chamada real aos Actors separadamente.

Implementado em src/modules/instagram/jobs:

- Schema interno estrito, com tipo/origem/alvo compativeis, IDs String, chave
  ativa e payload JSON opcionais. Nao e DTO de rota publica; nenhuma rota nova.
- Enqueue com upsert nativo do PostgreSQL, chave ativa unica. Repeticoes mantem
  payload, userId, alvo, agenda e tentativas do trabalho ja ativo. O updatedAt
  pode mudar pelo Prisma; isso nao equivale a iniciar coleta ou renovar posse.
  Falha do banco nao e apresentada como sucesso/duplicidade.
- Claim por UPDATE com SELECT FOR UPDATE SKIP LOCKED. Reserva uma tarefa PENDING
  disponivel, incrementa tentativas e grava token/prazo de posse atomicamente.
  Usa o relogio do PostgreSQL; nao depende do fuso/relogio do processo Node.
- Renovacao, conclusao e falha exigem o mesmo token de posse, estado RUNNING e
  prazo ainda valido. Comando de worker sem posse nao altera a tarefa.
- Falhas 1/2 voltam a PENDING com runAt em 1/5 minutos e preservam activeKey;
  a terceira encerra FAILED. Sucesso/ultima falha liberam activeKey e preservam
  a linha do historico. lastError recebe codigo sanitizado, nao stack/token/URL.
- Nenhuma rotina processa jobs automaticamente nesta etapa. Jobs RUNNING com
  lease vencida nao sao recapturados como se nada tivesse acontecido: a futura
  recuperacao deve consultar a execucao Apify antes de repetir chamadas pagas.
- O futuro worker deve proteger tambem a gravacao do dominio/snapshots com a
  posse na mesma transacao. Proteger apenas a conclusao do job nao garante que
  um worker antigo nao tente salvar dados; nao afirmar exactly-once de Actors.
- Nao ha alteracao de endpoints, cron, quota, snapshots ou chamadas ao provider.
  As chaves por perfil/post/Discover deverao ser construidas consistentemente
  pelos futuros chamadores; o banco nao deduz equivalencia de chaves diferentes.

A migration 20261123000000_add_instagram_sync_jobs foi aplicada ao Supabase de
DESENVOLVIMENTO apos commit. Nao foi acessada/configurada VPS nem feito deploy.
Os endpoints seguem: 7 prontos, 4 parciais e 5 pendentes. A proxima etapa integra
ProviderRun/Actors, retomada e worker com Initial Profile Sync. Pausar para commit.

Validacao da etapa I: 470 testes locais passaram (24 novos da fila); typecheck,
build, lint e format:check passaram. O teste PostgreSQL de fila passou em cerca
de 48s, com concorrencia real entre conexoes para enqueue e captura de tarefa,
SKIP LOCKED, renovacao, token incorreto, expiracao da posse, esperas de 1/5min,
terceira falha, liberacao da chave e preservacao do historico. O schema de teste
foi removido e sua ausencia foi confirmada. Como ha concorrencia entre conexoes,
esse teste usa commits e limpeza em finally, nao um rollback unico.
Prisma migrate status confirmou todas as migrations aplicadas no desenvolvimento.
Nenhum Actor foi iniciado; a tabela da fila nao recebeu tarefas de negocio.

## Etapa posterior J — worker Initial Profile Sync e ProviderRun

Implementado um processo separado para a VPS (src/worker.ts). Habilitacao
INSTAGRAM_WORKER_ENABLED=false por padrao, poll configuravel de 100 a 60000ms
(padrao 5000). Scripts dev:worker/start:worker. Nenhum deploy nem acesso a VPS.

- Consome apenas INITIAL_PROFILE_SYNC explicitamente enfileirado; nao varre
  perfis pending para criar Actors nem consome tipos ainda sem executor.
- Coleta perfil pelo username salvo e confere instagramId. Somente posts com
  ownerId correspondente sao candidatos. Deduplica, ordena por data e seleciona
  ate 12 retornados; desconhecidos ficam no fim. Nao promete cobertura global
  dos 12 mais recentes caso o provider nao os devolva.
- Reel Scraper recebe apenas URLs Instagram dos Reels selecionados, em uma
  execucao, sem add-ons de shares/transcript/download. Enriquecimento exige ID,
  tipo e autor correspondentes. Views de Profile Scraper continuam descartadas.
- ProviderRun passa a registrar as execucoes deste worker: Actor, trigger, usuario
  conhecido, apifyRunId, estado/erro sanitizado, items e usageTotalUsd quando
  disponivel, Decimal(10,6). Custo ausente/invalido fica null e releitura sem
  custo nao apaga valor conhecido. Nao usar os valores dos testes como preco.
  Rotas legadas ainda nao foram instrumentadas; endpoint 12 continua pendente.
- Referencias das etapas profile/reels sao gravadas no payload do job na mesma
  transacao que cria ProviderRun. Retomada usa o apifyRunId conhecido, inclusive
  para reler dataset apos falha de download. Uma execucao definitivamente falha
  pode ser repetida conforme as tres tentativas ja confirmadas.
- Apify SDK nao repete automaticamente o POST de inicio neste fluxo. Uma queda
  entre a chamada e a gravacao do ID gera PROVIDER_START_UNCERTAIN: sem prova de
  recusa, nao iniciar outro Actor automaticamente. O registro fica sem custo
  inventado e requer reconciliacao operacional; nao existe exactly-once externo.
- Posse de dez minutos renovada entre chamadas; retomada atomica de lease
  vencida troca token e mantem a tentativa, consultando execucoes persistidas.
  Falhas reais reagendam 1/5min e a terceira encerra como failed.
- Gravacao de perfil/posts/snapshots, syncStatus ready/lastSyncedAt e conclusao
  do job ocorrem na mesma transacao serializavel que bloqueia e valida a posse.
  Ha conferencias no inicio e com relogio real do banco antes do commit; uma
  posse vencida reverte as escritas. Falha final preserva dados anteriores.
- Reutilizada persistencia transacional do perfil, mantendo defaults legados
  (dez posts para o cron atual). Worker usa fonte initial e limite 12; snapshots
  de perfil continuam na regra atual de 24h. Nenhuma mudanca 20h/4h nesta etapa.
- Encerramento por sinal aguarda o job atual. Worker desabilitado sai sem abrir
  conexao. Nao registrar tokens, inputs completos ou erros SQL nos logs.

Consulta de contrato, sem executar Actor: documentacao oficial
https://apify.com/apify/instagram-reel-scraper/api/openapi e tipos do SDK instalado.
Os testes usam fixtures sanitizadas ja existentes e transporte simulado.

Esta etapa nao cria endpoint publico de fila, nao implementa a reserva do convite
(2) nem substitui o fluxo de concorrentes (14). As rotas continuam 7 prontas,
4 parciais e 5 pendentes, conforme inventario. O proximo passo e ligar o endpoint
2 ao enqueue transacional. Pausar para o commit antes de prosseguir.

Validacao da etapa J: 514 testes locais passaram (44 novos), cobrindo execucao
rastreada, retomada, custos nulos/zero, recusa/notice, POST incerto, download de
dataset, timeout de polling, autor divergente, limite/ordem dos posts, perda de
posse e falhas de persistencia. Cada ProviderRun criado e vinculado a tentativa
no payload: recuperar uma falha ja registrada na mesma tentativa nao inicia
outra execucao nem excede o total confirmado de tres tentativas.

O teste PostgreSQL opt-in passou em cerca de 67s com transporte Apify simulado.
Validou snapshots/BigInt/source initial, identidade/dono preservados, custos
fixture, retomada de Actor conhecido sem outro POST de perfil e rollback de
escrita de dominio quando a posse vence antes do commit. O schema temporario
foi removido e sua ausencia confirmada. Uma consulta de espera do proprio teste
foi corrigida para nao retornar o tipo PostgreSQL void ao Prisma; a repeticao
comprovou o rollback por vencimento da posse, nao por erro da consulta.

Typecheck, lint, format:check e build passaram. O entrypoint compilado com
INSTAGRAM_WORKER_ENABLED=false saiu sem executar tarefas. Nenhuma migration,
Actor pago, deploy ou alteracao dos registros de public nesta etapa. Custos e
SLA reais continuam sem medicao. Pausar para commit do usuario.

## Etapa K — reserva do convite e enqueue do Initial Sync (endpoint 2)

Decisao confirmada pelo usuario: consultar Apify para confirmar instagramId antes
da resposta, mantendo o body do guia. Reaproveitar essa execucao no worker para
nao iniciar um segundo Actor de perfil. A resposta aguarda essa consulta inicial,
nao a persistencia de snapshots nem o enriquecimento de Reels. Nao inventar IDs
para fingir resposta totalmente assincrona.

- POST /api/v1/internal/instagram/profiles exige token de servico com
  sub=hustleq-main e scope=service. Body estrito username/inviteId/reservedUntil.
  Username e normalizado; IDs continuam String, sem requisito UUID. Nao aceita
  ownerUserId, instagramId ou outros campos enviados pelo cliente.
- reservedUntil deve ser instante ISO futuro, com Z/offset. Rejeita expirado antes
  do provider e confere novamente com relogio do banco depois do lookup. Convite
  que vence enquanto consulta a Apify nao cria reserva, mas o custo real do
  lookup ja executado permanece no ProviderRun.
- Consulta rastreada ao Profile Scraper, com limite de execucao do Actor de 60s.
  Esse limite nao e uma garantia de latencia HTTP ou SLA real de dois minutos.
  Confere username retornado e trata inexistente/privado, falha e notice/recusa.
- Transacao serializavel busca por instagramId real: dono existente resulta em
  409 PROFILE_ALREADY_OWNED; reserva ativa de outro convite, 409 PROFILE_RESERVED.
  Reserva expirada pode ser substituida; mesmo convite pode repetir/atualizar prazo.
  Os retries Prisma nao repetem o lookup pago.
- Cria/reutiliza identidade sem dono e guarda a reserva. Nao cria snapshot ou post
  na requisicao. Fonte desconhecida, incluindo isVerified, permanece null.
- Perfil ready com lastSyncedAt ha menos de 24h e sem job ativo e reservado sem
  novo sync (resposta status ready). No limite de 24h, com data futura invalida
  ou sem sync pronto, enfileira Initial. Job ativo do mesmo perfil e reutilizado.
- Vinculacao da execucao verificada e enqueue acontecem junto da reserva. Payload
  guarda providerSteps/profile e providerAttempts=1 para o worker reler o mesmo
  run/dataset. Nao reatribuir ao perfil uma execucao ja vinculada a outro perfil.
- Resposta 201 direta com profileId, username e status syncing/ready. Perfil novo
  fica syncing ate o worker concluir; o processo deve estar habilitado separadamente.
  Repeticao nao duplica perfil/job ativo, mas cada novo POST pode consultar a
  identidade novamente e consumir credito. Nao prometer idempotencia de cobranca
  entre requisicoes HTTP distintas.
- ProviderRun do lookup usa trigger initial e userId null, pois a conta HustleQ
  pode ainda nao existir; nao atribuir o custo ao sub do token de servico. Custo
  nao e descartado em conflitos ou falhas de persistencia posteriores ao Actor.
- Falha/incerteza do inicio retorna 503 PROVIDER_UNAVAILABLE sem criar reserva;
  recusa limitada retorna 429 RATE_LIMITED com mensagem sanitizada da Apify.
  Perfil privado conserva 404 PROFILE_PRIVATE conforme contrato anterior;
  inexistente usa 404 PROFILE_NOT_FOUND. Banco/fila indisponivel e 500 INTERNAL_ERROR.

Sem migration, deploy, acesso a VPS ou execucao de Actor pago nesta etapa.
Endpoint 2 implementado no codigo. Estado: 8 endpoints prontos, 4 parciais e 4
pendentes. Integracao externa, SLA e cobranca reais continuam pendentes. Pausar
para o commit antes de prosseguir.

Validacao da etapa K: 561 testes locais passaram, incluindo 47 novos/cenarios
adicionados para reserva e mensagem de recusa sanitizada. Teste PostgreSQL com
HTTP/worker reais e transporte Apify simulado passou separadamente em cerca de
86s. Validou enqueue com reaproveitamento do lookup, gravacao pelo worker,
concorrencia entre convites (um 201 e um 409), idempotencia do perfil/job,
bloqueio de execucao pertencente a outro perfil e rollback quando a fila fica
indisponivel. O custo fixture do lookup permanece registrado mesmo no erro.
O schema temporario foi removido e sua ausencia foi confirmada.

Typecheck, lint, format:check e build passaram. Os testes PostgreSQL continuam
opt-in (cinco ignorados por padrao na suite local), sem Actors pagos ou alteracao
dos registros de public. Nenhuma migration ou deploy foi realizado. Esses testes
nao comprovam latencia ou preco real da Apify nem a integracao com o backend
principal. Endpoint 2 pronto no codigo; pausar para commit do usuario.

## Etapa L — busca de perfil e ownershipStatus (endpoint 1)

O usuario perguntou por que outra busca: o POST singular legado consulta E
persiste. O GET plural do guia tem contrato/papel diferentes e nao cadastra nem
reserva. Nao remover o legado nem trocar seu comportamento silenciosamente.
Foi extraida uma consulta rastreada compartilhada com o endpoint 2, preservando
seus contratos e o reaproveitamento do lookup pelo worker.

- GET /api/v1/instagram/profiles/search?username=... usa JWT de usuario sem scope.
  Nao exige OWNER/COMPETITOR para essa previa publica do Instagram. Query estrita,
  normalizacao de username e resposta direta conforme o guia, com null desconhecido.
- ownershipStatus por instagramId real, em leitura RepeatableRead: available,
  owned_by_me, owned_by_other ou reserved. Dono tem prioridade; reserva requer
  convite e prazo futuro, pelo relogio do banco. Nao expoe dono/convite/ID interno.
- Ausencia no banco significa available, nao not_found. Ausencia no Instagram
  retorna 200 apenas username/ownershipStatus=not_found. Perfil privado mantem
  404 PROFILE_PRIVATE (pedido anterior); falhas/limites/timeout sao erros.
- A busca nao escreve em InstagramProfile, reservas, posts, snapshots ou fila.
  Somente ProviderRun e gravado, com trigger search e usuario do sub. Informacao
  de disponibilidade e observacional; o POST interno revalida os conflitos.
- Limites para busca: Actor 20s, polling HTTP de 2s, timeout de transporte 5s,
  orcamento local 25s e transacao de ownership curta. Sem POST automatico repetido.
  Meta de menos de 30s continua precisando de teste real: limites nao demonstram
  SLA sob indisponibilidade do banco/rede. Nao usar duracao de mocks como SLA.
- Timeout/queda com ID conhecido preserva o ProviderRun para reconciliacao;
  custo desconhecido continua null, nao zero. A reconciliacao geral de execucoes
  fora do worker ainda depende da etapa de custos. Nao afirmar instrumentacao
  completa de todas as rotas legadas.
- Falhas de get/dataset do transporte agora viram PROVIDER_UNAVAILABLE, mantendo
  falhas do store/banco como INTERNAL_ERROR. Dataset de run SUCCEEDED pode ser
  relido pelo worker sem uma nova execucao, conforme a regra anterior.
- Sem migration, deploy, Actor pago ou alteracao de dados de public. GET novo,
  POST legado e contrato do convite coexistem; o SDK/normalizacao sao compartilhados.

Estado: 9 endpoints implementados, 3 parciais (13-15) e 4 pendentes (8,10,12,16).
Daily/Watched, Post Refresh, Discover, reconciliacao/custos completos e deploy
continuam pendentes. Pausar para commit do usuario ao terminar as verificacoes.

Validacao da etapa L: 593 testes locais passaram, incluindo 32 novos de busca,
autenticacao, ownership, ausencia/privacidade, erros, tempo limite, contagens
null/zero e ausencia de mutacoes de negocio. O teste PostgreSQL de convite foi
ampliado e passou em cerca de 74s, incluindo os cinco estados de busca, custo
atribuido ao usuario do token e verificacao de identidade/reserva/posts/snapshots/
fila preservados. O schema temporario foi removido e sua ausencia confirmada.
Typecheck, lint, format:check e build passaram. Os cinco testes de banco seguem
opt-in; nenhum Actor pago ou dado de public foi alterado. Nao houve migration
ou deploy. Latencia/custo reais e validacao do adaptador continuam pendentes.
Pausar para o commit do usuario.

## Etapa M — contas acompanhadas (endpoints 13, 14 e 15)

Decisoes confirmadas pelo usuario: inclusao com username apos previa GET,
remocao pelo ID da relacao com 204 e listagem no formato existente
`{ response: { relations, page, limit } }`. IDs internos continuam string CUID.

As quatro rotas existentes de concorrentes agora verificam que o JWT pertence
ao dono do perfil monitorador, incluindo a previa legada depreciada. A listagem
nao expoe ownerUserId nem campos de reserva. A remocao nao apaga historico e
repetir DELETE nao muda endedAt. Uma relacao encerrada deixa de conceder acesso
COMPETITOR; outra relacao ativa do mesmo usuario ainda pode conceder esse acesso.

O POST aceita apenas username. Faz lookup rastreado, com custo atribuido ao
solicitante, e revalida o dono e as regras em transacao serializavel: sem
autorreferencia, maximo de tres ativas, sem par ativo duplicado. O perfil alvo e
reutilizado pelo instagramId, preservando dono e reserva. A identidade, a relacao,
a vinculacao do ProviderRun e o enqueue Initial pertencem a mesma transacao.
Falha em qualquer dessas gravacoes reverte todas; o ledger do lookup pago continua.

O Initial reutiliza o lookup validado, sem segunda execucao de perfil pelo
worker. Jobs ativos do mesmo perfil sao reutilizados sem substituir payload ou
reiniciar tentativas; updatedAt pode ser atualizado pelo upsert. Adicionar de novo
uma conta removida cria outra relacao e preserva as antigas. O body antigo com
confirmed/confirmationToken devolve 400. A antiga rota POST competitors/search
permanece depreciada, sem persistir identidade, e seu comprovante nao e aceito no
novo POST. GET previa e POST inclusao fazem consultas independentes ao provider.

O worker deve ser habilitado separadamente. A inclusao cria a tarefa, nao espera
posts/snapshots. O Watched Sync diario permanece pendente; encerrar uma relacao
nao altera o filtro do cron legado que ainda seleciona todos os perfis salvos.
Nao houve migration, deploy nem chamada real a Actors nesta etapa.

Validacao: 600 testes locais passaram (6 integracoes opt-in ficam fora de npm
test). Teste PostgreSQL dedicado cobre HTTP real, persistencia, rollback, acesso,
reutilizacao do Initial e limite concorrente em schema isolado: passou em cerca
de 71 segundos, com remocao do schema temporario confirmada. Nenhum dado do
schema public foi alterado e o transporte da Apify foi mockado. Typecheck, lint,
format:check e build passaram. Estado: 12 endpoints implementados, nenhum
parcial e 4 pendentes (8, 10, 12 e 16). Permanecem os jobs/deploy e a validacao
externa do contrato e dos custos reais.

## Etapa N — custos mensais (endpoint 12)

O usuario definiu mes UTC e preservacao de null quando algum custo estiver
indisponivel. Isso amplia os campos monetarios numericos do exemplo do guia para
number | null; o adaptador do backend principal precisa aceitar essa decisao.

GET /api/v1/internal/costs?month=YYYY-MM exige token exato de servico e retorna
objeto direto, com month, totalUsd, byUser, byTrigger e unattributedUsd. Mes
obrigatorio/estrito, janela por startedAt UTC [inicio, proximo mes), incluindo
execucoes running/succeeded/failed. A data de termino nao move uma execucao de mes.

Uma unica consulta groupBy(userId, trigger) no ProviderRun calcula sum e counts,
e os mesmos grupos alimentam todos os totais. Soma usa Decimal, sem estimativa;
contagens e valores fora da faixa segura geram erro sanitizado. Total de grupo
com qualquer costUsd desconhecido vira null, preservando runs. Total geral
nessa situacao tambem e null; grupos completos permanecem numericos. Sem userId,
o custo entra em unattributedUsd e byTrigger. Sem registros, totais sao zero e
listas vazias. Zero conhecido nao vira null.

Nao chama Actors, nao concilia runs, nao atribui donos retroativamente, nao altera
registros e nao cria tabelas/migrations/configuracoes. Relatorio representa o
ledger rastreado, que ainda nao cobre todos os fluxos legados. A cobertura e a
conciliacao geral continuam pendentes; nao equivale a uma fatura completa Apify.

Validacao: 635 testes locais passaram; 7 integracoes opt-in ficam fora de npm
test. O teste PostgreSQL dedicado passou em cerca de 15 segundos, incluindo
limites UTC, soma Decimal, todos os status, nulls e preservacao das linhas lidas.
Schema temporario removido e ausencia confirmada; nenhum Actor real executado e
nenhuma linha do schema public alterada. Typecheck, lint, format:check e build
passaram.
Estado: 13 endpoints implementados, 3 pendentes (8, 10 e 16). Demais jobs,
conciliacao/cobertura de custos, deploy e integracao externa seguem pendentes.

## Etapa O — consulta de post e Post Refresh (endpoints 8 e 10)

UTC e contagem de tarefas aceitas com falha foram confirmados pelo usuario.
A variavel INSTAGRAM_MANUAL_REFRESH_DAILY_LIMIT tem padrao dez (1–1000).

GET /instagram/posts/:postId retorna o mesmo DTO da listagem com 200 se coletado
ha menos de 24h; a partir de 24h ou com data ausente/futura, enfileira on_open e
retorna 202 com status refreshing e os dados anteriores. POST .../refresh nao
recebe parametros e enfileira refresh, mesmo recente. Ambos exigem usuario e
OWNER/COMPETITOR. Service tokens nao sao aceitos.

Uma transacao ReadCommitted usa advisory lock por usuario no manual e FOR UPDATE
no post. Job ativo ou ProviderRun running com menos de dez minutos produz 202
sem outra tarefa/cota. A cota conta jobs manuais de todos os status por createdAt
UTC; o instante de aceitacao vem do relogio PostgreSQL apos obter as travas.
Conta entre posts/perfis diferentes do mesmo solicitante. Sem migracao nova.

O executor recupera leases expirados e consulta ProviderRuns persistidos usando
a infraestrutura rastreada. Tres tentativas no total, com esperas 1/5min. Retomar
lease nao aumenta tentativa nem duplica POST conhecido. Inicio incerto sem ID
permanece sem repeticao cega. Falhas sao registradas sem sobrescrever snapshots.

Reel Scraper para reel; instagram-scraper para photo/carousel por directUrls /p/,
resultsType posts e resultsLimit 1, verificado no OpenAPI oficial consultado em
23/11/2026: https://apify.com/apify/instagram-scraper/api/openapi.
Nao houve chamada real paga nem prova de Actor mais barato. A coleta valida
instagramPostId, ownerId e tipo. Snapshot e lastCollectedAt sao gravados junto
com conclusao do job, sob token/lease validos; conteudo estavel fica intacto.
Views apenas do Reel Scraper; desconhecidos null; source on_open ou refresh.

O worker VPS agora atende Initial e Post Refresh, separado da API e desligado por
padrao. Guard de transacao e retomada foram generalizados preservando as funcoes
anteriores do Initial. Jobs historicos nao devem ser apagados (sao o ledger de
consumo do teto). O cron legado/Daily/Watched nao foram alterados.

Validacao: 676 testes locais passaram (8 integracoes opt-in fora
de npm test). O teste Post Refresh PostgreSQL passou em cerca de 89 segundos,
com schema temporario removido e ausencia confirmada. Cobriu HTTP e worker reais,
transporte Apify mockado, deduplicacao, snapshot/source/likes ocultas, tres
tentativas, concorrencia na cota, dia anterior e rollback por lease vencido.
A regressao PostgreSQL do Initial passou em cerca de 69 segundos, com limpeza
do schema confirmada; a generalizacao das travas/retomada preservou o fluxo
existente. Typecheck, lint, format:check e build passaram. Nenhum Actor pago
foi executado e nenhuma linha do schema public foi alterada.
Estado: 15 endpoints implementados, somente o endpoint 16 Discover pendente.
Ainda faltam Daily/Watched, cobertura/conciliação completa de custos, deploy e
validacao externa de contratos, latencia e cobranca real.

## Etapa P — Discover (endpoint 16)

O usuario confirmou: manter 200 aguardando a busca, exigir niche/city e query
opcional, retornar erro quando atualizar cache vencido falhar (sem fallback stale).
O endpoint usa token de usuario ou servico exato, este ultimo para aquecimento.

Nicho/cidade/query sao normalizados sem acentos, em minusculas e com espacos
simples. Query vazia equivale a null. Chave interna e uma tupla JSON, sem colisoes
por delimitadores. O keyword enviado e a concatenacao dos tres componentes em
uma unica frase. Cada componente tem limite normalizado de 200 caracteres.

Cache com idade [0,24h) usa leitura; ausencia, idade >=24h ou data futura provoca
enqueue. Advisory lock por chave com transacao ReadCommitted coordena usuarios
concorrentes. Job ativo e compartilhado sem trocar solicitante/payload. Somente
a chamada criadora responde fromCache false; chamadas que esperam outra busca
respondem true. Cota comercial de vinte/mês continua no backend principal.

O job DISCOVER_SEARCH e atendido pelo worker separado. Usa Seemu keywords com um
termo combinado, maxPostsPerKeyword 50, postType all, minLikes 0, dateFrom 30 days.
Contrato conferido no OpenAPI oficial em 23/11/2026:
https://apify.com/seemuapps/instagram-keyword-posts-scraper/api/openapi.
Nao reutiliza filtro de 1000 likes sem local do Trends. Normaliza campos do guia,
curtidas ocultas e tipos, elimina posts sem data/futuros/antigos e duplicados,
ordena por data e limita a cinquenta. Preserva campos desconhecidos null.

So grava DiscoverCache e o ledger de jobs/ProviderRun, nao entidades de perfil,
post ou snapshots monitorados. Custo atribuido ao solicitante inicial; aquecimento
por servico usa null. Cache e conclusao de tarefa sao atomicos sob lease/token.
Tres tentativas totais, com esperas de 1/5min; retomada consulta runs conhecidos,
sem novo POST cego em inicio incerto. Cache vencido nao e apagado nem servido na
falha. Erro final 429/503 com mensagem sanitizada. Avisos nao viram posts vazios.

HTTP aguarda por polling ate concluir ou vencer INSTAGRAM_DISCOVER_WAIT_MS,
padrao 1320000 (22min), faixa 1000–3600000. Esse limite nao e garantia de SLA em
fila carregada. Worker precisa estar ativo; API nao executa Actor durante a
requisicao. Timeout/desconexao interrompe espera, sem remover job. Alinhar timeout
do backend/proxy; 202 nao foi introduzido. Cache publicado depois pode ser lido
em nova chamada. Aquecimento diario segue responsabilidade do backend principal,
sem novo cron nesta etapa. Nenhum Actor pago foi executado para testar.

Validacao: 736 testes locais passaram (9 integracoes opt-in ficam fora de npm
test). Typecheck, lint, format:check e build passaram. O teste PostgreSQL
dedicado passou em cerca de 89 segundos, com concorrencia real de usuarios,
cache compartilhado, custos/atribuicao, aquecimento service, tres falhas sem
servir/sobrescrever cache vencido e fencing/retomada de lease. Schema temporario
removido e ausencia confirmada; nenhum Actor real ou linha de public alterados. Estado: 16 endpoints
implementados; Daily/Watched, cobertura/conciliação completa de custos, deploy e
validacao externa de contratos/latencia/cobranca continuam pendentes.

## Etapa Q — Daily Profile Sync em lotes

Decisoes confirmadas em 24/11/2026: 4h America/New_York, vinte horas de intervalo
entre snapshots automaticos e lotes apenas do mesmo ownerUserId. Watched ficou
expressamente para uma etapa posterior.

A rota de cron existente agora enfileira, sem Actor no HTTP. Retorno e resumo de
enqueue (queued/reused/notDue/failed/pending), nao sucesso de coleta. Gate horario
4h00–4h59 e flags/CRON_SECRET preservados; compatibilidade Vercel alinhada para
8h/9h UTC, sem deploy. A VPS deve agendar chamadas (por exemplo, a cada hora UTC)
e manter worker separado. Nenhum agendamento foi instalado.

Enqueue agrupa por dono, divide lotes configuraveis de 1–10 (padrao cinco) e usa
transacao Serializable com locks ordenados de perfis. Owner/monitoringUntil e
lastSyncedAt >=20h sao verificados. Historico por perfil/data NY impede reiniciar
outro conjunto de tentativas no mesmo dia, inclusive depois de FAILED. Initial
ativo e membros pendentes de Daily em lote sao compartilhados, sem criar job
concorrente. Um Daily cujo dono deixou de ser o dono do perfil nao bloqueia nova
reserva/Initial. Reusar Daily no cadastro de concorrente nao muda ready para um
syncing que o Daily manteria para sempre em falha.

Job DAILY_PROFILE_SYNC guarda profileIds originais, remainingProfileIds,
completedProfileIds/skippedProfileIds e codigos de falha. O FK principal e apenas
um membro; os outros permanecem reservados pela lista JSON. Sem tabela/migration
nova. ProviderRun de lote multi-perfil fica sem perfil unico, com userId do dono
e custo real contado uma vez. Membership/runTargets permite rastrear a cobertura
sem ratear ou duplicar valor em varios usuarios.

Worker Profile Scraper em lote e Reel Scraper com URLs dos Reels dos doze posts
proprios retornados mais recentes. Usa a normalizacao e os guardas de identidade
existentes; nunca move post de autor. Perfil ausente/privado nao impede os demais
validos. Views desconhecidas permanecem null; erro operacional nao vira snapshot
sucesso com views null. Cada membro tem transacao sob fencing, e salva dados,
snapshots, lastSyncedAt e progresso do job atomicamente. Sucessos sao preservados
quando outro membro falha ou o processo cai.

Tres tentativas totais, esperas 1/5min, retomada na mesma tentativa e consulta de
runs conhecidos que cobrem o subconjunto restante. Nao refaz membro concluido nem
repete POST incerto. Depois da terceira, restante espera proximo dia com dados e
status anteriores. Payload invalido tambem termina em retries limitados. Nao ha
garantia de nova execucao paga para um dataset sucedido mas invalido: releituras
podem falhar ate esgotar tentativas. O Daily e atendido antes dos demais tipos no
ciclo do worker.

Regra de snapshot automatico 20h aplicada explicitamente a Initial e Daily. O
profile/search HTTP legado continua com default 24h; frescor de posts e Discover
nao mudam. A cota manual UTC e seus jobs tambem nao mudam.

Validacao PostgreSQL: teste Daily passou em cerca de 198 segundos pela porta
alternativa 6543/pgbouncer do mesmo pooler, aplicada apenas no processo de teste.
As duas URLs configuradas na porta 5432 deram timeout, inclusive fora do sandbox;
.env nao foi alterado. Schema temporario removido e ausencia confirmada.
Concorrencia real entre enqueues, custos unicos por dono, falha parcial, doze
posts, source/curtidas ocultas/views, guardas de 20h/data/owner/monitoring,
retomada e reaproveitamento de runs foram exercitados. Custos/Actors sao fixtures;
nenhum Actor real foi chamado e nenhuma linha de public foi alterada.
Validacao local: 776 testes passaram (10 integracoes opt-in ficam fora de npm
test). Typecheck, lint, format:check e build passaram. A mudanca nos mocks do
Initial acompanha a nova consulta de membership Daily; os contratos anteriores
continuam cobertos. A configuracao de conexao da aplicacao nao foi alterada.

Endpoints permanecem 16 implementados. Restam Watched, cobertura/conciliação de
custos dos fluxos legados, validacao real de Actors/SLA, integracao com backend e
deploy/configuracao da VPS.

## Etapa R — Watched Sync apos o Daily

Regras aprovadas em 24/11/2026: so relacoes ativas cujos perfis monitoradores
possuam ownerUserId e monitoringUntil nulo/futuro. A elegibilidade vem do
monitorador, nao do alvo: um alvo sem dono ou com seu antigo prazo encerrado
continua elegivel se houver monitorador valido. Um alvo compartilhado e coletado
uma vez. Um usuario distinto elegivel: ProviderRun.userId dele; varios usuarios:
userId null, custo uma vez em unattributedUsd, sem rateio inventado. Varios
perfis monitoradores do mesmo usuario contam como um usuario.

Cron existente enfileira Daily primeiro e, se nao houver falha/pendencia de
enqueue, Watched. Mesmo orcamento de 180s; resumo adicional watched; 503 se
qualquer enqueue ficar incompleto. Usa INSTAGRAM_DAILY_BATCH_SIZE (1–10, default
5), agrupando por atribuicao de custo, com grupo separado para null. Nenhuma
rota, tabela ou migration adicional. Worker separado atende Watched apenas apos
nao haver Daily PENDING/RUNNING, inclusive retries agendados. Jobs Daily antigos
na fila tambem precisam terminar para liberar essa barreira.

Enqueue serializavel/locks por alvo, membership dos membros secundarios e
lastSyncedAt de 20h impedem coletas concorrentes/repetidas. Revalidacao antes do
Actor e antes de salvar respeita relacoes encerradas, monitoramento e dono do
monitorador. A reserva ativa nao e liberada apenas por mudar o pagador: isso
evita outro lote concorrente enquanto o primeiro Actor pode estar rodando.
Mesmo que um membro seja descartado depois, a tentativa paga ja registrada
impede reabrir outra sequencia naquele dia. Reusar Watched no cadastro nao
deixa o perfil preso em syncing.
Mudanca da atribuicao antes da execucao remove o membro do lote antigo, sem
cobrar outro usuario; um cron posterior pode inclui-lo no grupo correto. Depois
que um Actor iniciou, a atribuicao daquela execucao fica preservada, nao e
recalculada retroativamente. Se todas as relacoes terminarem, a resposta do
Actor nao e persistida como uma nova coleta; o historico anterior permanece.

Se o Daily ja preparou/tentou o Actor de perfil ou concluiu o alvo na mesma data
NY, Watched nao abre nova sequencia, inclusive depois de falha Daily. Apenas
reservar e descartar um Daily sem Actor nao conta como tentativa. Watched pode
ficar enfileirado atras de um Daily ainda nao tentado; o worker espera a barreira
e decide depois se deve coletar ou descartar, sem abrir outro Actor. Jobs atrasados
tambem consultam a data NY atual, alem da data planejada. Preparar um run conta
conservadoramente como tentativa mesmo se o processo cair antes de confirmar o
POST. Uma falha terminal Watched tambem impede nova sequencia naquele dia.

O pipeline de coleta e compartilhado com Daily: perfil e doze posts proprios
mais recentes, Reel Scraper para views, normalizacao existente, fonte de metricas
source daily e ProviderRun.trigger watched. Perfil e snapshots/progresso sao
atomicos por membro sob lease/token. Dados desconhecidos ficam null; nao ha
remocao de historico. Tres tentativas totais com esperas 1/5min; sucessos parciais
preservados, runs conhecidos reutilizados, inicio incerto nao dispara POST cego.
A regra nao garante doze posts quando o provedor devolve menos dados validos.

Validacao local: 822 testes passaram; as 11 integracoes de banco opt-in nao
rodam no npm test comum. Typecheck, lint, format:check, build e smoke do worker
desabilitado passaram. O teste PostgreSQL dedicado passou em cerca de 174 segundos, em schema temporario,
com enqueues concorrentes, custo compartilhado contado uma vez, doze posts por
alvo, fontes inativas, barreira Daily (inclusive falha), troca de pagador sem liberar reserva ativa, fencing/retomada e
remocao do schema confirmada. Porta 6543/pgbouncer usada apenas no processo de
teste; .env preservado. Os custos e Actors sao simulados: nao houve Actor pago,
deploy, instalacao de scheduler ou alteracao de linhas de public.

Estado: 16/16 endpoints e 5/5 executores implementados em codigo. Restam
cobertura/conciliação geral de custos (incluindo legado), validacao real de
Actors/contratos/SLA, integracao com backend e configuracao/deploy da VPS.

## Etapa S — fechamento local, custos legados e operacao

O usuario solicitou finalizar as pendencias locais, sem novas pausas entre
subetapas. Nenhuma autorizacao de deploy, envio de segredos ou Actor pago foi
inferida. Permanecem dezesseis endpoints, cinco executores e oito tabelas.
Nao houve migration nem mudanca de DTO nesta etapa.

Buscas HTTP legadas profile/post/trends e previa depreciada de concorrente
estabelecem contexto AsyncLocalStorage com sub validado no JWT. O provider
registra um ProviderRun search antes da chamada paga, com userId externo,
apifyRunId quando confirmado, custo Decimal real/null, estado, itens e codigos
de falha. Nao confunde esse usuario com o autor do Instagram. Requests paralelos
nao compartilham identidade. Sem ledger disponivel, nao inicia chamada paga.
Erro de persistencia e sanitizado, sem SQL/credenciais no HTTP. SDK usa maxRetries
zero para evitar repeticao automatica de inicio incerto. Falha de download
preserva run sucedido e custo; recusas/notice-only registram falha. Sem ID depois
de timeout, mantem PROVIDER_START_UNCERTAIN, nunca assume zero ou repete POST.

npm run costs:reconcile, depois do build, consulta somente metadados de runs com
ID conhecido e estado running ou custo null. Limite 1–500, default100; --after
retoma pela ordem startedAt/id. Paginacao por comparacao de chave permanece
correta quando a linha anterior sai do filtro apos ser conciliada. Teste real
revelou e corrigiu esse caso. Escrita otimista compara estado/custo/erro/itens/
finishedAt observados, evitando sobrescrever atualizacao de worker concorrente.
Preserva custo conhecido quando o provedor omite valor e falha semantica de
notices mesmo com Actor SUCCEEDED. Nunca reassocia usuario, estima preco ou
inicia/reinicia Actor. Starts sem ID sao contados em unresolvedStarts e precisam
de conferencia humana; nao existe exactly-once externo ou conciliacao automatica
segura desse caso. Historico anterior nao rastreado nao recebe custo inventado.

Arquivos deploy/ preparados: API/worker systemd separados, timer e cliente HTTP
do cron via loopback/CRON_SECRET no header, exemplo de proxy e guia operacional.
Timer chama a cada dez minutos UTC; gate da API continua 4h NY e PostgreSQL
deduplica jobs. Segredos ficam fora do repositorio. Configuracao de TLS/dominio,
usuario de servico, caminhos Node/checkout e firewall sao do ambiente de destino.
Nao instalados/validados em VPS Linux; apenas guia e templates locais revisados.
A sintaxe do timer foi conferida no manual oficial systemd.time.

Validacao: 873 testes locais passaram; onze integracoes opt-in ficam fora do
npm test comum. Typecheck, lint, format:check e build passaram. Teste PostgreSQL
de custos passou em cerca de 37 segundos: endpoint mensal preservado, chamada
legada atribuida ao sub autenticado, custo Decimal, atualizacao concorrente e
paginacao apos remover linha do filtro. Schema temporario removido e ausencia
confirmada; conexao 6543 usada apenas no processo de teste. CLI compilada rejeitou
--limit 0 com exit1 antes de consultar runs; cliente cron passou em node --check
e em nove testes com HTTP simulado. Templates systemd/proxy nao foram executados
numa VPS. Actors/custos de testes sao simulados; nenhuma mutacao em public,
Actor pago, instalacao de servidor, envio de segredo ou deploy foi feito.
.env e arquivos pessoais nao foram alterados.

Estado final local: 16 endpoints e 5 executores implementados; ledger de chamadas
MVP/legadas, conciliacao e artefatos operacionais prontos. Dependencias externas:
validar contrato com o backend principal (inclusive prefixo/IDs String), executar
benchmark autorizado de Actors/custos/SLA e instalar/configurar a VPS. Nao declarar
producao pronta nem integracao externa concluida sem essas verificacoes.
