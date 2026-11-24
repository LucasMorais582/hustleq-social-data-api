# Modelagem Instagram — etapa 1

Esta etapa define os modelos e permite gerar o Prisma Client. Não aplica mudanças
no banco, não altera os endpoints e não implementa ainda persistência ou agendamento.
O modelo User foi adiado por decisão do projeto.

## Identificadores e relações

- IDs internos: `String` com geração `cuid()`. Não são UUID nem números.
- `InstagramProfile.instagramId` e `InstagramPost.instagramPostId`: IDs externos
  como strings únicas, sem conversão numérica.
- `InstagramProfile.ownerUserId`: referência externa opcional reservada para
  futura integração com a HustleQ. Ainda não há tabela User ou chave estrangeira.
- `InstagramPostMetricSnapshot.instagramPostId`: aponta para `InstagramPost.id`,
  o ID interno. O nome foi preservado conforme a especificação recebida.
- Uma relação de concorrência liga dois perfis, com papéis distintos. `endedAt`
  nulo identifica uma relação ativa; relações antigas não devem ser reutilizadas.
- Relações usam `onDelete: Restrict` para proteger o histórico de exclusões em cascata.

## Dados

Identidade do perfil e conteúdo dos posts ficam separados de suas métricas.
Campos externos que podem não ser informados são anuláveis. Contagens desconhecidas
(inclusive curtidas ocultas) são `null`, não zero. Hashtags e imagens são arrays de
strings do PostgreSQL, inicialmente vazios. Tipos de mídia são `photo`, `carousel`
e `reel`, como no contrato atual da API.

Datas usam `timestamptz` com precisão de milissegundos. `viewsCount` usa `BigInt`
para comportar contagens acima de 2.147.483.647. Na etapa de persistência/retorno
será necessário definir a conversão explícita, pois JSON não serializa bigint nativo.
Os modelos não são usados diretamente como contratos HTTP.

## Regras para as próximas etapas

As regras abaixo estão registradas, mas ainda não são garantidas apenas pelo schema:

- Snapshot de perfil somente após 24 horas desde a última coleta, com controle
  transacional para evitar duas requisições concorrentes. A unicidade por perfil
  e instante evita duplicação exata, mas não implementa a janela de 24 horas.
- No máximo três concorrentes ativos, sem autorreferência ou relações ativas
  duplicadas. Reentrada cria uma nova relação, preservando a anterior.
- Primeiro snapshot de métricas junto com a descoberta do post, na mesma transação.
- Snapshots de métricas são históricos; a aplicação não deve atualizar os anteriores.
- Atualização automática somente dos dez posts mais recentes; o limite diário de
  refresh manual ainda precisa ser definido antes de implementá-lo.

A próxima etapa deverá versionar a criação das tabelas com uma migration, revisar
as restrições e implementar a persistência. Não usar `db push` como substituto das
migrations nem conectar os services às tabelas antes de aplicá-las.

## Validação local sem mudar o banco

```bash
npx prisma validate
npm run prisma:generate
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

## Etapa 2 — migration inicial

A migration `20261117000000_create_instagram_models` foi gerada a partir do schema
Prisma. Cria cinco tabelas, o enum de mídia, índices e chaves estrangeiras.
O SQL usa uma transação: se uma instrução falhar, a criação inteira é revertida.
Não inclui `DROP`, `TRUNCATE`, `DELETE` ou alterações das tabelas já existentes.

Ainda não conecta os endpoints ao banco nem implementa as regras transacionais
da persistência. Os modelos `User` e autenticação/propriedade continuam separados.

A geração e revisão do SQL são locais. `prisma validate`, geração do Client e os
testes da API não comprovam a aplicação da migration em um PostgreSQL real.
Antes de aplicar, confirmar o ambiente de destino e revisar se já existem tabelas
ou histórico de migrations nesse banco. Em banco já populado sem histórico Prisma,
pode ser necessário um baseline; não executar reset para contornar essa situação.

Após a confirmação e revisão do destino, usar `npm run prisma:migrate:deploy`.
Não executar esse comando automaticamente nos endpoints. A validação da aplicação
real e o resultado de `prisma migrate status` devem ser registrados na etapa de aplicação.

## Aplicação verificada no desenvolvimento

A migration `20261117000000_create_instagram_models` foi aplicada ao banco de
desenvolvimento com autorização do responsável pelo projeto.

Verificações realizadas após o deploy:

- `prisma migrate status`: banco atualizado, sem migrations pendentes.
- `prisma migrate diff` entre banco e schema: nenhuma diferença detectada.
- Teste real com Prisma Client: criação e leitura dos cinco modelos, relações,
  campos nulos, arrays vazios e `viewsCount` acima do limite de INTEGER.
- A transação desse teste foi revertida intencionalmente, com leitura posterior
  confirmando que os registros de teste não permaneceram no banco.

Na conclusão da aplicação da migration, os endpoints ainda não persistiam as
coletas. A integração de profile/search foi adicionada na etapa 3, descrita abaixo.

## Etapa 3 — base transacional da persistência de perfis

`src/modules/instagram/profile/instagram.profile.repository.ts` recebe uma coleta
normalizada e usa uma transação serializável para salvar identidade do perfil,
snapshot quantitativo e publicações com seu primeiro snapshot de métricas.
Conflitos de concorrência são repetidos no máximo três vezes. A identidade é
atualizada pelo ID externo sem alterar `ownerUserId`.

O snapshot de perfil só é criado se não houver anterior ou se passaram pelo menos
24 horas desde o último. Posts já existentes têm conteúdo atualizado, mas não
recebem snapshots adicionais nesta etapa: o agendamento e o refresh seguem
pendentes. Falhas não são ignoradas e revertem a transação inteira.

Essa base está conectada ao `profile/search`: somente posts cujo `ownerId`
corresponde ao ID externo do perfil consultado são persistidos. Posts de outros
autores continuam no retorno HTTP, mas não são gravados nessa coleta. O repository
não transfere silenciosamente um post já vinculado a outro perfil.
`src/provider/database/prisma.client.ts` instancia o Client sob demanda;
importar o módulo não abre conexão nem muda os endpoints atuais.

O service valida e normaliza os dados antes da transação. Erros de persistência
retornam 503 com `code: PERSISTENCE_FAILED`; não há resposta de sucesso com dados
não salvos. O ID da resposta HTTP continua sendo o identificador externo.
A atualização é por demanda em `profile/search`; ainda não há rotina automática
a cada 24 horas nem atualização periódica de métricas dos dez posts mais recentes.

Validação desta etapa: 107 testes automatizados, typecheck, lint, formatação e
build aprovados. O repository também foi exercitado no PostgreSQL de desenvolvimento
com transação revertida: duas chamadas iguais não duplicaram perfil/post, uma
coleta 1 ms antes de 24 horas não criou snapshot e a coleta no limite exato criou.
Os snapshots anteriores e o primeiro snapshot do post permaneceram intactos
durante o teste. Após o rollback, não restaram registros de teste. O teste real
usou dados sintéticos e não iniciou execução paga na Apify.

## Etapa 4 — persistência condicional de post/search

`post/search` continua permitindo consultar autores não cadastrados. A resposta
HTTP mantém o formato e os identificadores externos. O repository consulta os
IDs externos dos autores em `InstagramProfile`, dentro da transação, e só grava
posts de autores existentes. Não cria nem atualiza perfis, não define proprietário
HustleQ e não cria snapshots de métricas do perfil.

Posts novos recebem seu primeiro snapshot de métricas junto com a gravação do
conteúdo. Posts existentes têm o conteúdo atualizado sem duplicar o registro,
sem mover o autor e sem acrescentar snapshots de métricas nesta etapa. Resultados
repetidos com o mesmo ID são gravados uma vez; autores conflitantes causam erro.
Posts sem os identificadores externos necessários continuam visíveis, mas não são
candidatos à gravação. Contadores incompatíveis com o armazenamento são rejeitados
antes de qualquer escrita. `videoPlayCount` tem prioridade sobre `videoViewCount`
para o snapshot de visualizações, inclusive quando vale zero.

A transação serializável repete conflitos no máximo três vezes. Se o banco estiver
indisponível, a consulta aos autores também pode falhar: o endpoint retorna 503,
`PERSISTENCE_FAILED`, em vez de assumir que o autor não existe. Dados de conexão
ou SQL não são enviados ao cliente. O histórico permanece preservado.

Trends continua exclusivamente para visualização, sem persistência. O agendamento
diário às 6h de `America/New_York` foi solicitado e confirmado, mas será uma etapa
separada: ainda não há cron ativo nem coleta automática neste commit. A rotina
deve usar o fuso nomeado para acompanhar o horário de verão, não um UTC fixo.

## Etapa 5 — rotina diária simples no Vercel

A rotina percorre todos os InstagramProfile salvos. `GET /api/cron/instagram-refresh`
é protegido por `Authorization: Bearer <CRON_SECRET>` (não é o JWT do usuário).
O endpoint é desabilitado por padrão: configurar `INSTAGRAM_REFRESH_ENABLED=true`
e um `CRON_SECRET` aleatório de pelo menos 32 caracteres no deploy antes de ativar.
A execução é aguardada; não há processamento em background após responder HTTP.

`vercel.json` define dois disparos diários, às 10h e 11h UTC. A aplicação verifica
`America/New_York` e ignora o disparo que não estiver na janela das 6h locais.
Isso acompanha o horário de verão. No Hobby, a execução pode ocorrer entre 6h e
6h59; no Pro, a precisão é por minuto. A configuração usa duas expressões diárias,
não uma expressão que dispara duas vezes por dia (incompatível com Hobby).
As definições do cron somente são ativadas após deploy de produção no Vercel.

Para cada perfil, a rotina limita a execução do Actor a 60 segundos e a espera a
70 segundos. Compara o ID externo com o perfil salvo, impedindo gravar dados de
outra conta que tenha assumido o username. A coleta usa o Actor de perfil existente;
não faz uma segunda coleta de posts. Posts não retornados pelo Actor não têm suas
métricas artificialmente copiadas para uma nova coleta.

Na transação, os dez posts salvos com datas conhecidas mais recentes são selecionados
por data decrescente (desempate por ID). Somente os que também vieram na coleta
recebem métricas atuais. Posts novos recebem o primeiro snapshot, mesmo se estiverem
fora dos dez, conforme a regra de descoberta. Uma repetição da rotina na mesma
janela das 6h não duplica snapshots já registrados nessa janela.

O intervalo mínimo de 24 horas dos snapshots de perfil foi preservado. Uma coleta
manual recente pode impedir outro snapshot às 6h. Na entrada do horário de verão,
dois disparos às 6h locais podem estar separados por 23 horas: nesse caso o snapshot
do perfil é adiado, enquanto as métricas dos posts seguem a janela diária.

### Limitações da versão simples escolhida

Não há tabela de execuções, fila, callback ou retomada durável. Há uma trava somente
no processo atual; instâncias diferentes ainda podem iniciar coletas simultâneas e
consumir créditos duplicados. As transações serializáveis protegem os snapshots no
banco, mas não evitam o custo dessas chamadas externas. Repetir manualmente o cron
pode iniciar uma nova coleta paga, mesmo quando os snapshots já estão atualizados.

O handler solicita `maxDuration: 300`; confirmar suporte/configuração de Fluid
Compute no projeto Vercel. A rotina deixa de iniciar outro perfil após 180 segundos,
reservando tempo para terminar a coleta atual. Ela não oferece capacidade ilimitada:
a lista pode ficar incompleta em caso de muitos perfis, chamadas lentas, limite de
créditos ou timeout da plataforma. Se houver falhas ou perfis pendentes, retorna 503,
`REFRESH_INCOMPLETE`, com contagens e códigos por perfil. Uma recusa 429 da Apify
interrompe o lote para não continuar fazendo chamadas recusadas. Não há retry
agendado automático nesta versão. Sucessos parciais já gravados são preservados.

Verificações: autenticação do cron, horário de verão, execução fora da janela,
falhas parciais, limite de tempo e atualização dos dez posts têm testes simulados.
Não iniciar o cron de produção durante os testes, pois ele consome créditos Apify.

Teste real da etapa 5 concluído no PostgreSQL de desenvolvimento, após repetir
uma tentativa que falhou por conexão: os dez posts mais recentes receberam um
novo snapshot, os posts nas posições 11 e 12 mantiveram apenas o anterior e uma
segunda execução não duplicou métricas na mesma janela. O snapshot de perfil
respeitou as 24 horas. A transação de teste foi revertida e a ausência de registros
de teste foi confirmada. Nenhuma execução Apify foi iniciada nesse teste.

## Etapa 6 — concorrentes com confirmação

Usa os modelos existentes, sem migration adicional. A busca de username é somente
consulta. Um comprovante assinado de dez minutos carrega a identidade conferida;
a confirmação explícita salva/reutiliza InstagramProfile pelo instagramId e cria
InstagramCompetitor na mesma transação serializável. ownerUserId não é preenchido.
Não cria snapshots nem posts; os perfis confirmados passam a integrar a rotina
existente que coleta todos os perfis salvos. Mesmo após encerrar uma relação,
o perfil e o histórico permanecem no banco e continuam sujeitos a essa rotina.

A transação verifica autorreferência, duplicidade ativa e limite de três ativos.
Conflitos P2034/P2002 têm até três tentativas, com nova validação das regras.
DELETE encerra somente a relação pertencente ao perfil indicado e mantém endedAt
original em repetições. Reentrada cria outra linha. A listagem separa ativos,
encerrados ou todos, com paginação. Autorização por proprietário aguarda o User.

## Etapa 7 — campos da MVP, DiscoverCache e ProviderRun

Migration aditiva: `20261119000000_add_mvp_tracking_and_cache`. Não remove nem
recria tabelas existentes e não altera IDs, relações ou snapshots antigos.
Os sete modelos usam IDs String com cuid(); nenhuma tabela User é criada.

- InstagramProfile recebe reservedForInviteId, reservedUntil, monitoringUntil,
  syncStatus (padrão pending) e lastSyncedAt. Perfis antigos ficam pending, com
  datas novas nulas: a migration não fabrica um sync completo.
- InstagramPost recebe lastCollectedAt, inicialmente nulo nos registros antigos.
  Uma nova descoberta o preenche na mesma transação do primeiro snapshot.
  A coleta diária só o avança quando grava uma métrica nova. Atualizar apenas
  conteúdo não torna métricas antigas recentes.
- InstagramPostMetricSnapshot recebe likesHidden (padrão false) e source anulável.
  Por autorização do usuário, os snapshots anteriores à migration mantêm
  source nulo. Novas descobertas via coleta legada usam initial; coletas diárias
  usam daily, inclusive posts descobertos durante elas. on_open e refresh serão
  acrescentados quando seus jobs forem implementados. Novas gravações existentes
  já informam source explicitamente; o banco aceita null para preservar o legado.
- DiscoverCache guarda key única, niche/city/query, results JSON e fetchedAt.
  A normalização da chave, TTL e o endpoint Discover ainda não estão implementados.
- ProviderRun guarda actor, apifyRunId, trigger, referências opcionais a perfil/post,
  userId externo, items, costUsd Decimal(10,6), status, error e instantes. Não há
  atribuição de custos nem criação automática de execuções nesta etapa. Custo
  desconhecido fica null. Os índices cobrem usuário/mês e buscas de perfil/post
  por status. Referências opcionais seguem o schema do guia, sem FK para User.

Contagens desconhecidas continuam anuláveis, viewsCount permanece BigInt e
as exclusões existentes continuam Restrict, preservando o histórico. O enum
interno de mídia permanece photo/carousel/reel; a adaptação HTTP para os valores
maiúsculos da MVP será feita na etapa de normalização. Não há mudança de quota,
horário do cron, quantidade de posts, contrato HTTP ou fluxo de convites aqui.

### Verificação opt-in da migration no PostgreSQL

```bash
RUN_DATABASE_TESTS=true npx vitest run tests/mvp-migration.integration.test.ts
```

Usa DIRECT_URL (ou DATABASE_URL), precisa de permissão para CREATE SCHEMA e testa
as duas migrations em um schema aleatório isolado, dentro de uma transação.
Cria dados legados antes da migration nova, verifica preservação/novas escritas,
custo Decimal, source e frescor. Faz rollback e confirma que o schema de teste
não ficou no banco. Não altera o schema public e não chama a Apify. O teste fica
ignorado no npm test padrão, evitando acessar banco real em CI sem autorização.

Etapa 7 validada e aplicada no Supabase de desenvolvimento: 270 testes locais,
teste PostgreSQL opt-in, Prisma validate/generate, typecheck, lint, format:check
e build passaram. O schema do banco corresponde ao Prisma (migrate diff sem
diferenças). Os 14 snapshots existentes ficaram com source null; as duas tabelas
novas estão vazias. Reinicie o servidor local para carregar o Prisma Client
regenerado antes de testar novamente as rotas.

## Etapa 8 — fila persistente na VPS (preparada para commit)

O usuario confirmou VPS e autorizou uma oitava tabela, InstagramSyncJob, como
infraestrutura interna dos cinco jobs. Nao e um novo endpoint de negocio.
Migration: `20261123000000_add_instagram_sync_jobs`.

Cada tarefa guarda tipo/estado, trigger, alvo de perfil/post por ID interno,
userId externo opcional, payload JSON opcional, tentativas e proxima execucao.
Os campos de posse (`lockedAt`, `leaseExpiresAt`, `lockToken`) preparam a
recuperacao pelo futuro worker. Nunca colocar tokens/credenciais no payload.

`activeKey` e unica entre tarefas ativas. A conclusao deve limpar essa chave,
os campos de posse e definir finishedAt, preservando o registro antigo. A
construcao consistente da chave e a captura atomica da tarefa ainda precisam
ser implementadas. Campos de lock nao implementam uma trava por si mesmos.

A migration inclui CHECKs SQL para estados coerentes, contador nao negativo e
alvo compativel com o tipo. O Prisma nao representa esses CHECKs: preservar o
SQL em migrations futuras. As FKs usam Restrict. IDs permanecem String/cuid.

ProviderRun continua registrando cada execucao real da Apify e seu custo;
InstagramSyncJob guarda a tarefa, que pode envolver mais de uma execucao.
Nenhum worker, disparo de Actor ou endpoint de fila foi criado nesta etapa.

Teste opt-in em schema temporario, com rollback e sem alterar public:

```bash
RUN_DATABASE_TESTS=true npx vitest run tests/instagram-sync-job-migration.integration.test.ts
```

A migration esta preparada e nao foi aplicada ao schema public. Depois do commit,
a proxima etapa aplicara a migration ao desenvolvimento e implementara a fila.

## Etapa 9 — fila aplicada e operacoes de persistencia

A migration 20261123000000_add_instagram_sync_jobs foi aplicada ao Supabase de
desenvolvimento apos commit. A API continua sem novos endpoints nesta etapa.

`src/modules/instagram/jobs/instagram.sync-job.repository.ts` implementa enqueue,
claim atomico com SKIP LOCKED, renovacao de posse, conclusao e falha/reagendamento.
O usuario definiu tres tentativas totais: inicial, espera de 1 minuto e espera de
5 minutos; a terceira falha encerra o job. O relogio usado nas transicoes e o do
PostgreSQL. A chave ativa e liberada na conclusao, mantendo o historico.

O worker ainda nao foi ligado aos Actors. Lease vencida nao e reexecutada
automaticamente: falta reconciliar ProviderRun/Apify e proteger a gravacao de
dados com o token de posse na mesma transacao. Nao iniciar um consumidor que
trate qualquer job como concluido sem executar e persistir a coleta real.

Teste de concorrencia real entre conexoes:

```bash
RUN_DATABASE_TESTS=true npx vitest run tests/instagram-sync-job-queue.integration.test.ts
```

Este teste usa schema aleatorio proprio com commits visiveis entre conexoes,
para disputar chaves e linhas bloqueadas. Remove o schema em finally e verifica
sua ausencia. Nao usa rollback unico, nao altera registros de public e nao chama
Apify. Os demais testes opt-in de migration continuam usando rollback.

## Etapa 10 — persistencia do Initial Profile Sync

Sem migration adicional. O worker Initial usa a tabela de fila aplicada e
ProviderRun. As referencias das etapas sao persistidas no JSON do job, sem
credenciais. IDs conhecidos da Apify permitem retomada da mesma execucao.

`saveProfileCollectionInTransaction` permite gravar os dados e concluir o job
na mesma transacao protegida pela posse. O worker usa source initial, ate 12
posts retornados do autor e views do Reel Scraper. As rotas/cron legados mantem
seus defaults. Snapshot de perfil continua com intervalo de 24h.

O novo teste opt-in valida esse fluxo no PostgreSQL com transporte Apify simulado:

```bash
RUN_DATABASE_TESTS=true npx vitest run tests/instagram-initial-sync.integration.test.ts
```

Cria e remove schema temporario, testa custos fixture, retomada e rollback por
posse vencida durante a transacao. Nao executa Actors nem altera public. O worker
fica desligado por padrao; o enqueue pelo endpoint de convites ainda e pendente.

## Etapa 11 — reserva de convite ligada a fila

Sem migration adicional. O endpoint 2 recebe username/inviteId/reservedUntil,
confirma a identidade com Apify e usa transacao serializavel para criar/reutilizar
perfil, reservar e enfileirar. A execucao de perfil ja paga e vinculada ao job
para o worker reler o mesmo dataset, sem outro POST de perfil para esse job.

Conflitos de dono/reserva ativa sao 409. Reserva expirada pode ser substituida;
mesmo convite nao duplica perfil/job ativo. Perfil pronto ha menos de 24h pode
ser reservado sem novo job. Campos ownerUserId e historicos nao sao sobrescritos
pela reserva. Worker continua separado e desligado por padrao.

Teste PostgreSQL com HTTP e worker reais, transporte Apify simulado, concorrencia
entre convites e falha controlada de acesso a fila:

```bash
RUN_DATABASE_TESTS=true npx vitest run tests/instagram-profile-reservation.integration.test.ts
```

Usa schema temporario proprio, preserva o custo do lookup quando a reserva falha
e confirma a limpeza do schema ao finalizar. Nao executa Actors pagos nem altera
registros de public. Contrato e limites estao detalhados no README principal.

## Custos mensais do ProviderRun

O endpoint 12 agrega ProviderRun por userId/trigger em uma consulta, filtrando
startedAt pelo mês UTC. Não precisa de migration nem regrava custos históricos.
Custos desconhecidos ficam null nos totais afetados; todos os status contam.

Teste PostgreSQL com schema temporário e dados de custo simulados:

```bash
RUN_DATABASE_TESTS=true npx vitest run tests/instagram-costs.integration.test.ts
```

Verifica limites UTC inclusivo/exclusivo, somas Decimal, execução iniciada em um
mês e terminada em outro, falhas com custo, custos null, execução sem userId e
leitura sem alteração das linhas. Remove e verifica a ausência do schema ao fim.
Não executa Actors nem altera o schema public.

## Post Refresh — cota e snapshots sem migration nova

Endpoints 8/10 usam as tabelas existentes. InstagramSyncJob é o ledger do teto
manual por usuário/dia UTC: inclui tarefas aceitas que falharam, sem contar retries
ou reutilização. Preservar o histórico de jobs para não perder essa contagem.
Advisory lock por usuário e lock por post protegem cota e enqueue concorrentes.
Snapshot, lastCollectedAt e conclusão da tarefa são uma transação sob lease.

```bash
RUN_DATABASE_TESTS=true npx vitest run tests/instagram-post-refresh.integration.test.ts
```

O teste usa schema próprio, HTTP/worker reais e transporte Apify simulado. Verifica
deduplicação, três tentativas, preservação dos snapshots, concorrência no teto,
dia anterior e rollback por lease vencido. Não altera registros de public.
