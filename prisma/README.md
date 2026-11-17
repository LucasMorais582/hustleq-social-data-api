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
