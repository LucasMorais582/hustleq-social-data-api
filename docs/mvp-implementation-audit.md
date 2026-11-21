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

Existem cinco modelos Prisma e uma migration inicial versionada. A aplicação
possui rotas legadas de coleta, concorrentes com confirmação e um cron simples.
Não há DiscoverCache, ProviderRun, reserva de convites nem execução durável
de jobs. Esta auditoria não reaplicou migrations, não consultou o banco e não
executou Actors. O estado implantado deve ser verificado na etapa apropriada.

## Inventário dos 16 endpoints

Os caminhos do guia não incluem o prefixo. Hoje as rotas de negócio usam
`/api/v1`; confirmar esse prefixo com o backend principal. As respostas atuais
costumam usar `{ response: ... }`, enquanto o guia mostra objetos diretos.

| #   | Endpoint do guia                                                | Situação no código                                                                                                          | Trabalho pendente                                                                                                      |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | GET /instagram/profiles/search                                  | Parcial: POST /instagram/profile/search consulta **e persiste**; há lookup sem persistência usado na prévia de concorrentes | GET com query, normalização, ownershipStatus, ausência como 200/not_found, ProviderRun search e prazo de resposta <30s |
| 2   | POST /internal/instagram/profiles                               | Ausente                                                                                                                     | Reserva por convite, conflitos de dono/reserva, disparo Initial Sync sem aguardar                                      |
| 3   | POST /internal/instagram/profiles/:profileId/owner              | Ausente                                                                                                                     | Atribuição de dono por token de serviço, limpeza da reserva e conflitos                                                |
| 4   | DELETE /internal/instagram/profiles/:profileId/reservation      | Ausente                                                                                                                     | Liberar reserva, preservar dados, 204                                                                                  |
| 5   | GET /instagram/profiles/:profileId                              | Ausente                                                                                                                     | Identidade + snapshot mais recente, syncStatus, lastSyncedAt, escopo; somente banco                                    |
| 6   | GET /instagram/profiles/:profileId/posts                        | Ausente                                                                                                                     | Posts do banco com métrica mais recente, filtros, ordem por data e paginação com total; limit máximo 50                |
| 7   | GET /instagram/profiles/:profileId/snapshots                    | Ausente                                                                                                                     | Histórico crescente, intervalo de datas, escopo, sem paginação                                                         |
| 8   | GET /instagram/posts/:postId                                    | Ausente; POST /instagram/post/search coleta por username, não é equivalente                                                 | Frescor por lastCollectedAt, 200 ou 202, on_open assíncrono e deduplicação                                             |
| 9   | GET /instagram/posts/:postId/metrics                            | Ausente                                                                                                                     | Histórico crescente, likesHidden/source, filtros e escopo; vazio é 200                                                 |
| 10  | POST /instagram/posts/:postId/refresh                           | Ausente                                                                                                                     | Post salvo, 202, execução durável, deduplicação, teto de segurança e falha sem substituir histórico                    |
| 11  | PATCH /internal/instagram/profiles/:profileId/monitoring        | Ausente                                                                                                                     | monitoringUntil e sua aplicação ao Daily; token de serviço                                                             |
| 12  | GET /internal/costs                                             | Ausente                                                                                                                     | Agregações mensais de ProviderRun por usuário/trigger e custos não atribuídos                                          |
| 13  | GET /instagram/profiles/:profileId/competitors                  | Parcial: lista relações ativas/encerradas com paginação                                                                     | Contrato exato do adaptador e escopo OWNER; não expor ownerUserId                                                      |
| 14  | POST /instagram/profiles/:profileId/competitors                 | Parcial: exige confirmed:true e comprovante de prévia; salva identidade e relação atomicamente                              | Guia pede body username após busca no endpoint 1, código COMPETITOR_ALREADY_REGISTERED e Initial Sync                  |
| 15  | DELETE /instagram/profiles/:profileId/competitors/:competitorId | Parcial: usa ID da relação, encerra endedAt, retorna 200 com objeto                                                         | Confirmar se competitorId é ID da relação ou do perfil acompanhado; retornar 204 e aplicar escopo                      |
| 16  | GET /instagram/discover                                         | Ausente; trends/search tem o Actor reaproveitável                                                                           | Nicho/cidade/query, cache compartilhado 24h, contrato plano, fromCache, aquecimento com serviço e atribuição de custo  |

O guia afirma contrato de Watched sem mudanças, mas difere do fluxo de
confirmação implementado e aprovado nesta conversa. Não substituir esse fluxo
sem confirmar a compatibilidade desejada.

## Autenticação e erros

Já existem verificação HS256, iss/aud configuráveis, sub/exp obrigatórios e
Bearer JWT nas rotas de negócio. Ainda não há distinção entre usuário e serviço
nem verificação de propriedade/relação ativa. ownerUserId ainda não é atribuído.

Pendências:

- Rotas de usuário: sub deve identificar o usuário da HustleQ; derivar OWNER
  de ownerUserId e COMPETITOR das relações ativas dos perfis desse usuário.
- Rotas internal: exigir sub=hustleq-main e scope=service, recusando demais com 403.
- Aquecimento Discover com serviço não deve consumir cota de usuário.
- Token por chamada com validade de cinco minutos; a emissão local atual usa
  uma hora por padrão. Alinhar a validação temporal e exemplos com o emissor.
- O cron atual usa CRON_SECRET, não token de serviço. Definir como coexistirá
  com os jobs e chamadas do backend principal.
- Padronizar erros como `{ error: { code, message, time } }`. Hoje o formato é
  `{ statusCode, code, message }`, além de erros próprios do Fastify/cron.
- Códigos atuais como UNAUTHORIZED, COMPETITOR_ALREADY_ACTIVE e
  PROVIDER_RATE_LIMITED diferem de UNAUTHENTICATED,
  COMPETITOR_ALREADY_REGISTERED e RATE_LIMITED do guia.
- Search inexistente no guia é 200/not_found; hoje é 404/PROFILE_NOT_FOUND.
  Perfil privado já tem erro próprio; esclarecer sua resposta no novo contrato.
- O lookup sem perfil não deve ser confundido com falha operacional do provider.

O backend principal continuará sendo o único cliente. Não criar login público,
token no navegador, cálculos de Analytics ou entidade User nesta API.

## Banco: cinco tabelas atuais e duas pendentes

| Tabela                      | Já existe                                                          | Alterações previstas pelo guia                                                              |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| InstagramProfile            | Identidade, ownerUserId opcional, relação com posts/snapshots      | reservedForInviteId, reservedUntil, monitoringUntil, syncStatus, lastSyncedAt               |
| InstagramProfileSnapshot    | Contagens anuláveis e collectedAt; intervalo transacional de 24h   | Resolver contradição 20h/24h; guia sugere contagens não anuláveis                           |
| InstagramCompetitor         | Relação Profile → Profile, endedAt e histórico, máximo três ativos | Autorizar por dono/relação e integrar elegibilidade ao Watched Sync                         |
| InstagramPost               | Identidade externa única, conteúdo, arrays e perfil                | lastCollectedAt e normalização/serialização do contrato                                     |
| InstagramPostMetricSnapshot | Histórico imutável; viewsCount BigInt                              | likesHidden e source initial/daily/on_open/refresh; estratégia para registros antigos       |
| DiscoverCache               | Não                                                                | Chave normalizada única, resultado JSON e fetchedAt                                         |
| ProviderRun                 | Não                                                                | Actor, run ID, trigger, perfil/post, userId, itens, custo Decimal, status, erro e instantes |

Decisões a confirmar antes da migration:

- IDs atuais usam String com cuid(), guia fala UUID. Nenhum ID existente será
  convertido automaticamente. Manter string não é o mesmo que garantir UUID.
- FKs atuais usam Restrict para preservar histórico; exemplos do guia usam
  Cascade em algumas relações. Não introduzir exclusão em cascata sem aprovação.
- Contagens/isVerified e alguns campos de post hoje aceitam null para dados
  indisponíveis; o guia combina exemplos obrigatórios com a regra de nunca
  inventar campos ausentes. Definir defaults/backfill sem fabricar números.
- BigInt protege views grandes; não reduzir a Int sem avaliar limite e precisão.
  O contrato JSON exige conversão explícita; bigint nativo não é serializável.
- syncStatus pending/syncing/ready/failed e ProviderRun running/succeeded/failed
  precisam validação e transições claras. Definir recuperação de running antigo.
- ProviderRun tem IDs opcionais no exemplo. Definir relações/índices e mecanismo
  de trava transacional; um simples findFirst seguido de create não impede
  duas requisições simultâneas de iniciar a mesma coleta.
- Não marcar dados antigos como recém-coletados ao preencher lastCollectedAt
  ou lastSyncedAt. Propor backfill baseado no histórico ou deixar null.

## Jobs: base atual e lacunas

| Job                  | Base existente                                                                                      | Pendências                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Initial Profile Sync | Coleta síncrona de perfil, posts do próprio ownerId e primeiro snapshot                             | Job durável disparado por convite/concorrente, status, 12 posts, Reel Scraper, custos e tentativas                                       |
| Daily Profile Sync   | Cron simples às 6h de Nova York para todos os perfis; atualiza métricas de até dez posts observados | Passar para 4h após confirmação, elegibilidade dono/monitoringUntil, 12 posts, Reels, lotes, ProviderRun, retry e conclusão antes das 6h |
| Watched Sync         | Todos os perfis salvos entram no cron atual, inclusive relações encerradas                          | Coletar acompanhados por relações ativas, após Daily, deduplicar perfis compartilhados, custos e tentativas                              |
| Post Refresh         | Não existe                                                                                          | URL de post salvo, Actor adequado, on_open/refresh, deduplicação, snapshot e lastCollectedAt                                             |
| Discover Search      | Trends usa o keyword Actor sem cache                                                                | Cache 24h, consulta ampla até 50 posts/30dias, fromCache, custos, aquecimento e tentativas                                               |

O cron atual roda dentro da requisição, sequencialmente, com trava somente no
processo e orçamento de 180s para iniciar coletas, maxDuration 300s. Não há fila,
callback, retomada durável nem retry de Actor em 1/5/15min. Os retries de
transação Prisma existentes **não são retries dos jobs**.

Antes de criar execução assíncrona, decidir infraestrutura compatível com o
deploy: não responder 202 e deixar uma Promise solta ou um setTimeout esperando
minutos em uma função serverless. Nenhuma plataforma/fila nova foi escolhida.
O guia menciona backend principal no Railway; isso não confirma o local de
hospedagem desta API, anteriormente planejada para Vercel.

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

## Normalização: reaproveitar e corrigir

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
