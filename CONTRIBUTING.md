# Contribuindo

## Fluxo de trabalho

1. Crie uma branch para a tarefa (`feat/...`, `fix/...`, `chore/...` ou `docs/...`).
2. Faça mudanças pequenas e focadas.
3. Execute `npm run typecheck`, `npm run lint`, `npm run format:check` e `npm test`.
4. Abra uma Pull Request para `main`.
5. Não faça commit de `.env`, tokens ou credenciais.

## Convenções

- TypeScript estrito.
- Validação de entrada com Zod.
- Rotas agrupadas por módulo de domínio.
- Regras de negócio em services, não diretamente nos handlers HTTP.
- Integrações externas encapsuladas em providers.
- Alterações de schema do banco versionadas por migrations Prisma.
- Respostas e contratos da Social Data API não devem expor payloads brutos dos providers.

## Antes de adicionar modelos de domínio

Consulte a documentação técnica atualizada. Alguns contratos, scopes e regras ainda estão sendo fechados; não codifique suposições como decisões definitivas.
