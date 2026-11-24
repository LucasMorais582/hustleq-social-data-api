// Executado por timer, não é rota nova. O segredo fica no header, nunca na URL/log.
const secret = process.env.CRON_SECRET;
if (!secret || secret.length < 32) throw new Error('CRON_SECRET não configurado');
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida');
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/cron/instagram-refresh`, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(240000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  console.info('Agendamento Instagram processado');
} catch {
  console.error('Falha ao enfileirar Instagram; consulte o serviço da API.');
  process.exitCode = 1;
}
