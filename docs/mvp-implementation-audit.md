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
- O usuário pediu limite configurável de 2 refreshes por dia, reiniciado à
  meia-noite, aplicado a perfis/posts já salvos. A responsabilidade exata e o fuso
  ainda precisam ser alinhados com o guia antes de implementar.
- Variáveis de ambiente configuram limites; a contagem precisa ser persistida
  e protegida contra concorrência. Uma variável em memória não atende a múltiplas
  instâncias/reinícios do Vercel.

## Resultado da comparação

Há uma base funcional de coleta e persistência, não a entrega completa dos
16 endpoints do guia. Nenhum item deve ser considerado integralmente compatível
apenas por ter uma rota parecida: faltam contratos, autorização ou jobs.

Situacao atualizada em 23/11/2026: as sete tabelas do guia estao modeladas e suas
migrations foram aplicadas ao Supabase de desenvolvimento. Uma oitava tabela
InstagramSyncJob foi autorizada para a fila na VPS; sua migration esta preparada
para revisao/commit e ainda nao foi aplicada ao schema public. Ha persistencia,
normalizacao e guards JWT de usuario/servico. Os endpoints 5, 6 e 7 usam
OWNER/COMPETITOR nas leituras do banco; o endpoint 9 entrega o historico de metricas dos posts. Os demais endpoints continuam pendentes
ou parciais; a criacao de reservas, cache em uso, custos e jobs duraveis
ainda faltam. Atribuicao de dono e liberacao de reserva estao nos endpoints 3/4. As secoes posteriores registram as etapas ja concluidas.

## Funcionalidades - acompanhamento atual

| Funcionalidade                     | Situacao                         | O que falta                                                        |
| ---------------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| Sete tabelas e migrations          | Prontas                          | Evolucoes quando necessarias nas proximas etapas                   |
| Fila interna da VPS                | Modelo/migration preparados      | Aplicar apos commit; implementar enqueue, posse, retomada e worker |
| IDs string e legado                | Prontos                          | Alinhamento externo sobre CUID, que nao e UUID                     |
| JWT de usuario/servico             | Base pronta                      | Ligar os guards as demais rotas MVP                                |
| Normalizacao e fixtures            | Base pronta                      | Enriquecimento real pelo Reel Scraper nos jobs                     |
| Persistencia                       | Base pronta                      | Integrar os novos fluxos/jobs                                      |
| Leituras de perfil/posts/historico | Endpoints 5-7 e 9 prontos        | Validar com o adaptador do backend principal                       |
| Convites, reserva e dono           | Parcial: endpoints 3 e 4 prontos | Endpoint 2 e Initial Sync                                          |
| Concorrentes/Watched               | Parcial                          | Contrato MVP, autorizacao e Initial/Watched Sync                   |
| Coleta diaria                      | Parcial                          | Prazo aplicado; faltam 12 posts/4h, elegibilidade MVP e jobs       |
| Post Refresh e teto de seguranca   | Pendentes                        | Endpoints 8/10, deduplicacao, fuso e quota                         |
| Custos Apify                       | Estrutura pronta                 | Preencher ProviderRun e endpoint 12                                |
| Discover/cache                     | Estrutura/provider prontos       | Endpoint 16, cache compartilhado e aquecimento                     |
| Deploy e integracao com backend    | Pendentes                        | Definir hospedagem/jobs e validar no ambiente acordado             |

## Inventário dos 16 endpoints

Os caminhos do guia não incluem o prefixo. Hoje as rotas de negócio usam
`/api/v1`; confirmar esse prefixo com o backend principal. As rotas legadas
usam `{ response: ... }`; as novas leituras 5-7 retornam objetos diretos como no guia.

| #   | Endpoint do guia                                                | Situação no código                                                                                                          | Trabalho pendente                                                                                                      |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | GET /instagram/profiles/search                                  | Parcial: POST /instagram/profile/search consulta **e persiste**; há lookup sem persistência usado na prévia de concorrentes | GET com query, normalização, ownershipStatus, ausência como 200/not_found, ProviderRun search e prazo de resposta <30s |
| 2   | POST /internal/instagram/profiles                               | Ausente                                                                                                                     | Reserva por convite, conflitos de dono/reserva, disparo Initial Sync sem aguardar                                      |
| 3   | POST /internal/instagram/profiles/:profileId/owner              | Pronto nesta etapa                                                                                                          | Validacao externa com o backend principal                                                                              |
| 4   | DELETE /internal/instagram/profiles/:profileId/reservation      | Pronto nesta etapa                                                                                                          | Validacao externa com o backend principal                                                                              |
| 5   | GET /instagram/profiles/:profileId                              | Pronto nesta etapa                                                                                                          | Validacao externa; isVerified pode ser null por decisao do usuario                                                     |
| 6   | GET /instagram/profiles/:profileId/posts                        | Pronto nesta etapa                                                                                                          | Validacao externa com o adaptador                                                                                      |
| 7   | GET /instagram/profiles/:profileId/snapshots                    | Pronto nesta etapa                                                                                                          | Validacao externa com o adaptador                                                                                      |
| 8   | GET /instagram/posts/:postId                                    | Ausente; POST /instagram/post/search coleta por username, não é equivalente                                                 | Frescor por lastCollectedAt, 200 ou 202, on_open assíncrono e deduplicação                                             |
| 9   | GET /instagram/posts/:postId/metrics                            | Pronto nesta etapa                                                                                                          | Validacao externa com o adaptador                                                                                      |
| 10  | POST /instagram/posts/:postId/refresh                           | Ausente                                                                                                                     | Post salvo, 202, execução durável, deduplicação, teto de segurança e falha sem substituir histórico                    |
| 11  | PATCH /internal/instagram/profiles/:profileId/monitoring        | Pronto nesta etapa                                                                                                          | Filtro no cron atual pronto; aplicar tambem aos futuros jobs MVP                                                       |
| 12  | GET /internal/costs                                             | Ausente                                                                                                                     | Agregações mensais de ProviderRun por usuário/trigger e custos não atribuídos                                          |
| 13  | GET /instagram/profiles/:profileId/competitors                  | Parcial: lista relações ativas/encerradas com paginação                                                                     | Contrato exato do adaptador e escopo OWNER; não expor ownerUserId                                                      |
| 14  | POST /instagram/profiles/:profileId/competitors                 | Parcial: exige confirmed:true e comprovante de prévia; salva identidade e relação atomicamente                              | Guia pede body username após busca no endpoint 1, código COMPETITOR_ALREADY_REGISTERED e Initial Sync                  |
| 15  | DELETE /instagram/profiles/:profileId/competitors/:competitorId | Parcial: usa ID da relação, encerra endedAt, retorna 200 com objeto                                                         | Confirmar se competitorId é ID da relação ou do perfil acompanhado; retornar 204 e aplicar escopo                      |
| 16  | GET /instagram/discover                                         | Ausente; trends/search tem o Actor reaproveitável                                                                           | Nicho/cidade/query, cache compartilhado 24h, contrato plano, fromCache, aquecimento com serviço e atribuição de custo  |

O guia afirma contrato de Watched sem mudanças, mas difere do fluxo de
confirmação implementado e aprovado nesta conversa. Não substituir esse fluxo
sem confirmar a compatibilidade desejada.

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
- Search inexistente ainda e 404 no legado; o endpoint 1 novo devera usar 200 e
  ownershipStatus=not_found. Resposta para perfil privado continua a esclarecer
  ao criar esse endpoint. Falha operacional nao deve virar perfil inexistente.
- Aquecimento Discover e jobs com token de servico continuam pendentes.

## Banco - sete tabelas aplicadas e fila adicional preparada

| Tabela                      | Estado atual                                                  | Pendente                                                         |
| --------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| InstagramProfile            | Identidade, reserva, monitoramento, syncStatus e lastSyncedAt | Fluxos internos, elegibilidade e atualizacao pelos jobs          |
| InstagramProfileSnapshot    | Contagens anulaveis e collectedAt; intervalo atual de 24h     | Resolver 20h/24h do guia antes de mudar os jobs                  |
| InstagramCompetitor         | Relacao, endedAt, historico e limite de tres ativos           | Adaptar contrato/autorizacao e elegibilidade do Watched Sync     |
| InstagramPost               | Conteudo e lastCollectedAt ligados a gravacao de metrica nova | Frescor de leitura/on_open no endpoint 8                         |
| InstagramPostMetricSnapshot | Historico imutavel, likesHidden, source, views BigInt         | Endpoint 10 e fontes dos novos jobs; legado preserva source null |
| DiscoverCache               | Modelo e migration aplicados                                  | Endpoint, chave normalizada, TTL e coordenacao de buscas         |
| ProviderRun                 | Modelo, Decimal e indices aplicados                           | Registro das execucoes, custos, deduplicacao e recuperacao       |

Decisoes preservadas: IDs internos String/cuid(), sem conversao para UUID;
FKs anteriores com Restrict; contagens e isVerified desconhecidos podem ser null.
Datas de coleta novas nao receberam backfill no legado. Source antigo fica null,
com novas gravacoes initial/daily; on_open/refresh dependem dos jobs. Nao ha User.

Views BigInt sao convertidas nas leituras novas apenas dentro da faixa segura
do JSON Number; valores maiores geram erro sem arredondamento. Os proximos jobs
precisam implementar transicoes de status e trava duravel: apenas consultar
ProviderRun e depois criar uma linha nao impede execucoes concorrentes.

## Jobs: base atual e lacunas

| Job                  | Base existente                                                                                | Pendências                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Initial Profile Sync | Coleta síncrona de perfil, posts do próprio ownerId e primeiro snapshot                       | Job durável disparado por convite/concorrente, status, 12 posts, Reel Scraper, custos e tentativas                                       |
| Daily Profile Sync   | Cron simples as 6h de Nova York; respeita monitoringUntil e atualiza ate dez posts observados | Passar para 4h após confirmação, elegibilidade dono/monitoringUntil, 12 posts, Reels, lotes, ProviderRun, retry e conclusão antes das 6h |
| Watched Sync         | Todos os perfis salvos entram no cron atual, inclusive relações encerradas                    | Coletar acompanhados por relações ativas, após Daily, deduplicar perfis compartilhados, custos e tentativas                              |
| Post Refresh         | Não existe                                                                                    | URL de post salvo, Actor adequado, on_open/refresh, deduplicação, snapshot e lastCollectedAt                                             |
| Discover Search      | Trends usa o keyword Actor sem cache                                                          | Cache 24h, consulta ampla até 50 posts/30dias, fromCache, custos, aquecimento e tentativas                                               |

O cron atual roda dentro da requisição, sequencialmente, com trava somente no
processo e orçamento de 180s para iniciar coletas, maxDuration 300s. Não há fila,
callback, retomada durável nem retry de Actor em 1/5/15min. Os retries de
transação Prisma existentes **não são retries dos jobs**.

Antes de criar execução assíncrona, decidir infraestrutura compatível com o
deploy: não responder 202 e deixar uma Promise solta ou um setTimeout esperando
minutos em uma função serverless. A VPS foi confirmada; o worker ainda sera implementado.
O guia menciona backend principal no Railway; isso não confirma o local de
hospedagem desta API, anteriormente planejada para Vercel.

Atualizacao em 23/11/2026: o usuario confirmou VPS para esta API. Planejar API e
worker como processos separados, com tarefas persistidas no PostgreSQL para
retomada apos reinicios. O usuario autorizou explicitamente a oitava tabela
InstagramSyncJob, mantendo ProviderRun exclusivamente para execucoes reais dos
Actors e custos. A modelagem e migration estao preparadas para commit; a aplicacao
no schema public e implementacao do worker ficam para a proxima etapa. O cron
legado nao foi substituido e nenhuma VPS foi acessada ou configurada.

O guia manda iniciar às 4h e terminar antes da leitura das 6h, enquanto a decisão
anterior do usuário era iniciar às 6h. Também diz “no máximo um snapshot em 24h”
e, nas regras comuns, deduplicação por 20h. Resolver ambos antes de alterar o cron.
Confirmar o significado de três tentativas com esperas de 1, 5 e 15min.

## Refresh manual: decisões ainda necessárias

- Pedido do usuário: duas atualizações por dia, reinício à meia-noite, limite
  configurável, somente perfis/posts salvos.
- Guia: dois refreshes por conta no backend principal; aqui apenas teto de
  dez por dia por usuário, configurável. on_open não consome a cota manual.
- Endpoint especificado é por post, não um refresh de perfil inteiro. Confirmar
  se “mediante ao perfil e aos posts salvos” significa escopo/pertencimento ou
  também uma operação adicional de atualização do perfil; não inventar endpoint.
- Qual fuso rege o teto desta API? O guia usa fuso da conta para a cota do backend
  principal, mas esta API não recebe nem armazena esse fuso hoje. Um usuário pode
  ter mais de uma conta. Não usar o fuso do servidor implicitamente.
- Contador diário deve sobreviver a deploys e a chamadas simultâneas. Planejar
  uso de ProviderRun/reserva transacional; não criar oitava tabela por suposição.
- Execução em andamento retorna 202 sem novo consumo. Falha mantém os dados e
  não deve descontar a cota comercial; alinhar como o backend principal acompanha
  o resultado e o que conta no teto de segurança.

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
