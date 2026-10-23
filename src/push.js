'use strict';
// Notificações PUSH do painel (v1.9.20) — Web Push de verdade: o aviso de
// pedido novo cai na TELA BLOQUEADA do celular, mesmo com o app fechado.
// ---------------------------------------------------------------------------
// Como funciona: cada aparelho inscrito (botão no painel) guarda uma
// "inscrição" (endpoint do serviço de push do navegador + chaves). No pedido
// novo, o servidor assina com as chaves VAPID do sistema e despacha.
//   • Android (Chrome): funciona plenamente.
//   • iPhone: só no painel INSTALADO na tela inicial, iOS 16.4+ (Apple).
//   • As chaves VAPID nascem na primeira subida e ficam no banco.
//   • Sem a dependência 'web-push', o módulo inteiro vira no-op silencioso.
const { get, all, run, execSql, modoBanco } = require('./db');

let webpush = null;
try { webpush = require('web-push'); } catch { webpush = null; }

async function criarTabelas() {
  if (modoBanco() === 'sqlite') {
    await execSql(`
CREATE TABLE IF NOT EXISTS config_push (
  id INTEGER PRIMARY KEY,
  vapid_publica TEXT,
  vapid_privada TEXT,
  assunto TEXT
);
CREATE TABLE IF NOT EXISTS push_inscricoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  chaves_json TEXT NOT NULL,
  user_agent TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);
  } else {
    await execSql(`
CREATE TABLE IF NOT EXISTS config_push (
  id INTEGER PRIMARY KEY,
  vapid_publica TEXT,
  vapid_privada TEXT,
  assunto TEXT
);
CREATE TABLE IF NOT EXISTS push_inscricoes (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  chaves_json TEXT NOT NULL,
  user_agent TEXT,
  criado_em TIMESTAMPTZ DEFAULT now()
);
`);
  }
}

let vapid = null; // { publica, privada, assunto }

async function preparar() {
  try {
    await criarTabelas();
    await run('INSERT OR IGNORE INTO config_push (id) VALUES (1)');
    if (!webpush) { console.error('[push] pacote web-push ausente — notificações desligadas.'); return; }
    const row = await get('SELECT * FROM config_push WHERE id=1');
    if (row && row.vapid_publica && row.vapid_privada) {
      vapid = { publica: row.vapid_publica, privada: row.vapid_privada, assunto: row.assunto || 'https://pedidos-acai-guri.vercel.app' };
    } else {
      const k = webpush.generateVAPIDKeys();
      vapid = { publica: k.publicKey, privada: k.privateKey, assunto: 'https://pedidos-acai-guri.vercel.app' };
      await run('UPDATE config_push SET vapid_publica=?, vapid_privada=?, assunto=? WHERE id=1', vapid.publica, vapid.privada, vapid.assunto);
    }
    webpush.setVapidDetails(vapid.assunto, vapid.publica, vapid.privada);
  } catch (e) { console.error('[push] preparar:', e.message); }
}

function chavePublica() { return vapid ? vapid.publica : null; }

async function inscrever(usuarioId, sub, userAgent) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return { ok: false, erro: 'Inscrição inválida.' };
  }
  const chaves = JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth });
  await run(`INSERT INTO push_inscricoes (usuario_id, endpoint, chaves_json, user_agent) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET usuario_id=excluded.usuario_id, chaves_json=excluded.chaves_json, user_agent=excluded.user_agent`,
    usuarioId, String(sub.endpoint), chaves, String(userAgent || '').slice(0, 200));
  return { ok: true };
}

async function desinscrever(usuarioId, endpoint) {
  await run('DELETE FROM push_inscricoes WHERE usuario_id=? AND endpoint=?', usuarioId, String(endpoint || ''));
  return { ok: true };
}

// Envia para TODOS os aparelhos inscritos (dono + equipe). Falha de um
// aparelho nunca atrapalha os outros; inscrição morta (404/410) é removida.
async function enviarParaTodos(payload) {
  if (!webpush || !vapid) return { enviados: 0, motivo: 'push-indisponivel' };
  const lista = await all('SELECT * FROM push_inscricoes');
  let enviados = 0;
  await Promise.allSettled(lista.map(async (ins) => {
    let chaves = {};
    try { chaves = JSON.parse(ins.chaves_json || '{}'); } catch { /* inscrição velha */ }
    const sub = { endpoint: ins.endpoint, keys: { p256dh: chaves.p256dh, auth: chaves.auth } };
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600 });
      enviados++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        await run('DELETE FROM push_inscricoes WHERE id=?', ins.id).catch(() => {});
      }
    }
  }));
  return { enviados, total: lista.length };
}

// Disparo principal: pedido novo (chamado pelo núcleo de pedidos).
async function novoPedido(pedido) {
  try {
    const total = ((pedido.total_centavos || 0) / 100).toFixed(2).replace('.', ',');
    const tipo = pedido.tipo === 'retirada' ? 'Retirada' : 'Entrega';
    return await enviarParaTodos({
      titulo: `Novo pedido #${pedido.numero}`,
      corpo: `${pedido.cliente_nome || 'Cliente'} — R$ ${total} · ${tipo}`,
      url: '/painel',
      tag: `pedido-${pedido.id}`,
    });
  } catch (e) { console.error('[push] novoPedido:', e.message); return { enviados: 0 }; }
}

// Teste do botão no painel: manda só pros aparelhos do usuário logado.
async function testar(usuarioId) {
  if (!webpush || !vapid) return { ok: false, erro: 'Push indisponível neste servidor.' };
  const lista = await all('SELECT * FROM push_inscricoes WHERE usuario_id=?', usuarioId);
  if (!lista.length) return { ok: false, erro: 'Nenhum aparelho inscrito. Ative as notificações neste aparelho primeiro.' };
  let enviados = 0;
  for (const ins of lista) {
    let chaves = {};
    try { chaves = JSON.parse(ins.chaves_json || '{}'); } catch { /* idem */ }
    try {
      await webpush.sendNotification(
        { endpoint: ins.endpoint, keys: { p256dh: chaves.p256dh, auth: chaves.auth } },
        JSON.stringify({ titulo: 'Teste do painel', corpo: 'As notificações estão funcionando neste aparelho.', url: '/painel', tag: 'teste-push' }),
        { TTL: 300 });
      enviados++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        await run('DELETE FROM push_inscricoes WHERE id=?', ins.id).catch(() => {});
      }
    }
  }
  return { ok: enviados > 0, enviados, erro: enviados ? undefined : 'O serviço de push recusou o envio. Tente reativar as notificações.' };
}

module.exports = { preparar, chavePublica, inscrever, desinscrever, enviarParaTodos, novoPedido, testar };
