# Operação na VPS (referência)

Ambiente atual informado em 25/11/2026: worker no Railway, serviço
`social-data-worker`, com `npm run start:worker` e
`INSTAGRAM_WORKER_ENABLED=true`. O backend principal chama o cron a cada dez
minutos. API e worker são serviços separados; não usar o cliente loopback deste
diretório para chamar outro serviço no Railway nem instalar um segundo timer.

Arquivos de exemplo para uma VPS Linux com systemd e Node.js 22+. Não foram
instalados em nenhum servidor. Os caminhos e o usuário devem corresponder à VPS:
`/opt/hustleq-social-data-api`, conta de serviço `hustleq`, Node em `/usr/bin/node`.
A API e o worker precisam do mesmo banco e das mesmas variáveis de ambiente.

## Preparar a versão

No checkout revisado e com as credenciais configuradas no servidor:

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run prisma:generate
npm run build
npm run prisma:migrate:deploy
```

O arquivo `/etc/hustleq/social-data-api.env` fica fora do repositório, legível
somente pelo administrador e grupo `hustleq` (por exemplo, root:hustleq, modo 0640).
Usar `.env.example` como referência, preenchendo as credenciais reais apenas no
servidor. Configurar NODE_ENV=production, JWT_SECRET compartilhado com o backend,
DATABASE_URL/DIRECT_URL, APIFY_API_TOKEN, CRON_SECRET e
INSTAGRAM_REFRESH_ENABLED=true. O unit do worker habilita seu executor.
Não copiar o `.env` pessoal para o Git nem para logs. Confirmar os limites/custos
antes de habilitar o worker, pois jobs reais consomem Apify.

Instalar os arquivos `.service` e `.timer` deste diretório em
`/etc/systemd/system/`, depois executar no servidor:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hustleq-api.service
sudo systemctl enable --now hustleq-worker.service
sudo systemctl enable --now hustleq-instagram-cron.timer
```

O timer chama somente loopback a cada dez minutos. A API filtra a janela das
4h de Nova York e o PostgreSQL deduplica os enqueues. Assim o horário de verão
não depende do fuso do sistema. A sintaxe do timer segue o
[manual oficial systemd.time](https://www.freedesktop.org/software/systemd/man/latest/systemd.time.html). Persistent=true recupera o disparo do timer;
se a VPS voltar depois das 4h59, a API aguarda a próxima janela diária.
Não há promessa de terminar antes das 6h sem medir o volume/latência reais.

A API escuta na porta PORT (padrão 3000). Mantê-la inacessível publicamente,
expondo apenas o proxy HTTPS. `nginx.conf.example` é um bloco local de referência:
ajustar domínio, porta e TLS no proxy existente. Discover sem cache responde 202 imediatamente; o backend consulta de novo até
receber 200. O timeout de 22min e a variável INSTAGRAM_DISCOVER_WAIT_MS foram
removidos do fluxo HTTP. As outras leituras usam o banco.
O único consumidor é o backend principal, não o navegador.

## Verificações e parada

```bash
systemctl status hustleq-api hustleq-worker hustleq-instagram-cron.timer
journalctl -u hustleq-api -u hustleq-worker --since today
curl --fail http://127.0.0.1:3000/api/v1/health
```

Swagger em `/docs`. As 16 rotas MVP usam `/api/v1`; JWT HS256 com iss=hustleq,
aud=hustleq-social-data-api, sub=userId e validade máxima de 5min. Rotas internas
exigem sub=hustleq-main e scope=service. O backend mantém cotas comerciais.

Para impedir novas coletas automáticas, desabilitar o timer ou definir
INSTAGRAM_REFRESH_ENABLED=false e reiniciar a API. Isso não cancela jobs já
persistidos. Parar o worker impede novas execuções; um Actor já iniciado na Apify
pode continuar cobrando até terminar. O worker trata SIGTERM e guarda IDs/leases
para retomada. Não apagar jobs/ProviderRun para destravar execuções.

## Custos e conciliação

GET `/api/v1/internal/costs?month=YYYY-MM` usa o ledger real, com mês UTC. Não
transforma custo desconhecido em zero. Rotas legadas de busca também registram
o usuário autenticado. Usuários distintos acompanhando o mesmo alvo compartilham
uma execução e seu custo aparece em unattributedUsd, sem rateio estimado.

Depois do build, consultar execuções conhecidas e atualizar somente o ledger:

```bash
npm run costs:reconcile -- --limit 100
```

O comando não inicia Actors. Se nextCursor vier preenchido, continuar com
`--after ID` usando o valor retornado. Isso evita que custos indisponíveis nas
linhas antigas impeçam examinar execuções mais novas. Conferir failed/conflicts
e repetir quando apropriado. unresolvedStarts exige conferência operacional na
Apify: sem ID confirmado não há associação automática segura. Não reiniciar um
Actor incerto para tentar obter o custo. Não retroatribuir usuários por palpite.

A conciliação é manual nesta entrega; nenhum timer extra ou endpoint foi criado.
Nunca publicar segredos junto com o comando. Pode-se compartilhar a URL de teste
e o segredo do JWT com o responsável pelo backend por um canal privado autorizado.
