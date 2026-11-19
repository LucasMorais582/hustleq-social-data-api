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
