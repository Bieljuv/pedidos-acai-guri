'use strict';
// Programa de Fidelidade (v1.9.17) — pedido do Gabriel: reconhecer o cliente
// que volta, mostrar o progresso na tela dele e premiar quem bate a meta.
// ---------------------------------------------------------------------------
// Regras:
//   • Identidade do cliente = WhatsApp normalizado (o mesmo dos pedidos).
//   • Compra válida = pedido ENTREGUE (cancelado/trote não conta).
//   • A cada `meta_compras` entregas, nasce um PRÊMIO (tabela fidelidade_premios,
//     único por cliente+marco) e o dono é avisado no Telegram.
//   • Prêmio "entrega_gratis": resgate AUTOMÁTICO — zera a taxa do próximo
//     pedido de entrega (se esse pedido for cancelado, o prêmio volta).
//   • Prêmio "personalizado": vale o texto que o adm escreveu (ex.: "1 Combo
//     Gurizinhos"); o cliente vê o vale na tela e o adm dá baixa no painel.
//   • A config vive no BANCO (config_fidelidade, linha única id=1).
//   • Nada aqui pode travar uma venda ou uma transição: tudo é try/catch.
const { get, all, run, execSql, modoBanco } = require('./db');
const { normalizaFone } = require('./util');
const notif = require('./notificacoes');

const TEXTO_ENTREGA_GRATIS = 'Entrega grátis no próximo pedido';

async function criarTabelas() {
  if (modoBanco() === 'sqlite') {
    await execSql(`
CREATE TABLE IF NOT EXISTS config_fidelidade (
  id INTEGER PRIMARY KEY,
  loja_id INTEGER NOT NULL DEFAULT 1,
  ativo INTEGER NOT NULL DEFAULT 0,
  meta_compras INTEGER NOT NULL DEFAULT 5,
  premio_tipo TEXT NOT NULL DEFAULT 'entrega_gratis',
  premio_texto TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fidelidade_premios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id INTEGER NOT NULL DEFAULT 1,
  whatsapp TEXT NOT NULL,
  cliente_nome TEXT,
  marco_compras INTEGER NOT NULL,
  premio_tipo TEXT NOT NULL,
  premio_texto TEXT,
  status TEXT NOT NULL DEFAULT 'disponivel',
  pedido_origem_id INTEGER,
  pedido_resgate_id INTEGER,
  criado_em TEXT DEFAULT (datetime('now')),
  resgatado_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_premios_whats ON fidelidade_premios (whatsapp, status);
CREATE TABLE IF NOT EXISTS sorteios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id INTEGER NOT NULL DEFAULT 1,
  titulo TEXT NOT NULL,
  premio_texto TEXT NOT NULL,
  periodo_ini TEXT,
  periodo_fim TEXT,
  total_clientes INTEGER NOT NULL DEFAULT 0,
  total_chances INTEGER NOT NULL DEFAULT 0,
  ganhador_whatsapp TEXT,
  ganhador_nome TEXT,
  ganhador_chances INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);
  } else {
    await execSql(`
CREATE TABLE IF NOT EXISTS config_fidelidade (
  id INTEGER PRIMARY KEY,
  loja_id INTEGER NOT NULL DEFAULT 1,
  ativo INTEGER NOT NULL DEFAULT 0,
  meta_compras INTEGER NOT NULL DEFAULT 5,
  premio_tipo TEXT NOT NULL DEFAULT 'entrega_gratis',
  premio_texto TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fidelidade_premios (
  id SERIAL PRIMARY KEY,
  loja_id INTEGER NOT NULL DEFAULT 1,
  whatsapp TEXT NOT NULL,
  cliente_nome TEXT,
  marco_compras INTEGER NOT NULL,
  premio_tipo TEXT NOT NULL,
  premio_texto TEXT,
  status TEXT NOT NULL DEFAULT 'disponivel',
  pedido_origem_id INTEGER,
  pedido_resgate_id INTEGER,
  criado_em TIMESTAMPTZ DEFAULT now(),
  resgatado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_premios_whats ON fidelidade_premios (whatsapp, status);
CREATE TABLE IF NOT EXISTS sorteios (
  id SERIAL PRIMARY KEY,
  loja_id INTEGER NOT NULL DEFAULT 1,
  titulo TEXT NOT NULL,
  premio_texto TEXT NOT NULL,
  periodo_ini TEXT,
  periodo_fim TEXT,
  total_clientes INTEGER NOT NULL DEFAULT 0,
  total_chances INTEGER NOT NULL DEFAULT 0,
  ganhador_whatsapp TEXT,
  ganhador_nome TEXT,
  ganhador_chances INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ DEFAULT now()
);
`);
  }
}

async function preparar() {
  try {
    await criarTabelas();
    // Sorteio DIVULGADO (v1.16.9): a tabela sorteios ganha o status —
    // 'ativo' (criado e sendo anunciado pros clientes), 'sorteado'
    // (ja teve ganhador) ou 'encerrado' (divulgacao cancelada). Os
    // sorteios antigos, que ja nasciam sorteados, leem 'sorteado'.
    if (modoBanco() === 'sqlite') {
      try { await execSql(`ALTER TABLE sorteios ADD COLUMN status TEXT DEFAULT 'sorteado'`); } catch { /* coluna ja existe */ }
    } else {
      await execSql(`ALTER TABLE sorteios ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'sorteado'`);
    }
    await run('INSERT OR IGNORE INTO config_fidelidade (id, loja_id) VALUES (1, 1)');
  } catch (e) { console.error('[fidelidade] preparar:', e.message); }
}

async function getConfig() {
  const c = (await get('SELECT * FROM config_fidelidade WHERE id=1')) || {};
  return {
    ativo: !!c.ativo,
    meta_compras: Math.min(50, Math.max(2, Number(c.meta_compras) || 5)),
    premio_tipo: c.premio_tipo === 'personalizado' ? 'personalizado' : 'entrega_gratis',
    premio_texto: c.premio_texto || '',
  };
}

async function salvarConfig(dados) {
  const atual = await getConfig();
  const prox = {
    ativo: dados.ativo !== undefined ? (dados.ativo ? 1 : 0) : (atual.ativo ? 1 : 0),
    meta_compras: dados.meta_compras !== undefined
      ? Math.min(50, Math.max(2, Number(dados.meta_compras) || 5)) : atual.meta_compras,
    premio_tipo: dados.premio_tipo === 'personalizado' ? 'personalizado' : 'entrega_gratis',
    premio_texto: dados.premio_texto !== undefined
      ? String(dados.premio_texto || '').trim().slice(0, 120) || null : (atual.premio_texto || null),
  };
  await run(`INSERT INTO config_fidelidade (id, loja_id, ativo, meta_compras, premio_tipo, premio_texto, updated_at)
    VALUES (1, 1, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET ativo=excluded.ativo, meta_compras=excluded.meta_compras,
      premio_tipo=excluded.premio_tipo, premio_texto=excluded.premio_texto, updated_at=datetime('now')`,
    prox.ativo, prox.meta_compras, prox.premio_tipo, prox.premio_texto);
  return getConfig();
}

function textoPremio(cfg) {
  return cfg.premio_tipo === 'entrega_gratis'
    ? TEXTO_ENTREGA_GRATIS
    : (cfg.premio_texto || 'Prêmio de fidelidade');
}

async function contarEntregues(whatsapp) {
  const w = normalizaFone(whatsapp);
  const r = await get("SELECT COUNT(*) c FROM pedidos WHERE loja_id=1 AND cliente_whatsapp=? AND status='ENTREGUE'", w);
  return Number(r && r.c) || 0;
}

async function premioDisponivel(whatsapp) {
  const w = normalizaFone(whatsapp);
  return (await get("SELECT * FROM fidelidade_premios WHERE loja_id=1 AND whatsapp=? AND status='disponivel' ORDER BY id LIMIT 1", w)) || null;
}

// Situação do cliente (painel, tela do cliente e checkout).
async function statusCliente(whatsapp) {
  const cfg = await getConfig();
  if (!cfg.ativo) return { ativo: false };
  const compras = await contarEntregues(whatsapp);
  const premio = await premioDisponivel(whatsapp);
  const noCiclo = compras % cfg.meta_compras;
  const faltam = premio ? 0 : (noCiclo === 0 ? cfg.meta_compras : cfg.meta_compras - noCiclo);
  return {
    ativo: true,
    compras,
    meta: cfg.meta_compras,
    no_ciclo: premio ? cfg.meta_compras : noCiclo,
    faltam,
    premio_tipo: cfg.premio_tipo,
    premio_texto: textoPremio(cfg),
    premio: premio ? {
      id: premio.id, tipo: premio.premio_tipo, texto: premio.premio_texto,
      marco: premio.marco_compras, criado_em: premio.criado_em,
    } : null,
  };
}

// Prêmio de entrega grátis aguardando resgate (usado na criação do pedido).
async function premioResgatavel(whatsapp) {
  const cfg = await getConfig();
  if (!cfg.ativo) return null;
  const p = await premioDisponivel(whatsapp);
  return (p && p.premio_tipo === 'entrega_gratis') ? p : null;
}

async function consumirPremio(premioId, pedidoId) {
  await run("UPDATE fidelidade_premios SET status='resgatado', pedido_resgate_id=?, resgatado_em=datetime('now') WHERE id=? AND status='disponivel'", pedidoId, premioId);
}

// Chamado a cada transição de pedido (nunca pode travar a transição).
async function aoTransicionar(pedido, para) {
  try {
    if (!pedido || !pedido.cliente_whatsapp) return;
    if (para === 'CANCELADO') {
      // Se o pedido cancelado tinha consumido o prêmio, ele volta a valer.
      await run("UPDATE fidelidade_premios SET status='disponivel', pedido_resgate_id=NULL, resgatado_em=NULL WHERE pedido_resgate_id=? AND status='resgatado'", pedido.id);
      return;
    }
    if (para !== 'ENTREGUE') return;
    const cfg = await getConfig();
    if (!cfg.ativo) return;
    const whats = normalizaFone(pedido.cliente_whatsapp);
    const total = await contarEntregues(whats);
    if (!total || total % cfg.meta_compras !== 0) return;
    const ja = await get('SELECT id FROM fidelidade_premios WHERE loja_id=1 AND whatsapp=? AND marco_compras=?', whats, total);
    if (ja) return;
    const texto = textoPremio(cfg);
    await run(`INSERT INTO fidelidade_premios (loja_id, whatsapp, cliente_nome, marco_compras, premio_tipo, premio_texto, pedido_origem_id)
      VALUES (1, ?, ?, ?, ?, ?, ?)`, whats, pedido.cliente_nome || null, total, cfg.premio_tipo, texto, pedido.id);
    try {
      await notif.notificarDonoTexto(
        `🎉 *Fidelidade:* ${notif.escMd(pedido.cliente_nome || 'Cliente')} completou ${total} compras e ganhou um prêmio: ${notif.escMd(texto)}!\n` +
        `O prêmio já está valendo para o próximo pedido${cfg.premio_tipo === 'entrega_gratis' ? ' (a entrega sai grátis sozinha)' : ''}.`);
    } catch { /* Telegram é bônus; o prêmio já está salvo */ }
  } catch (e) { console.error('[fidelidade] aoTransicionar:', e.message); }
}

async function listarPremios() {
  return all('SELECT * FROM fidelidade_premios WHERE loja_id=1 ORDER BY id DESC LIMIT 50');
}

async function ranking(limite = 20) {
  return all(`SELECT p.cliente_whatsapp AS whatsapp, COALESCE(c.nome, MAX(p.cliente_nome)) AS nome,
      COUNT(*) AS compras
    FROM pedidos p LEFT JOIN clientes c ON c.loja_id=1 AND c.whatsapp = p.cliente_whatsapp
    WHERE p.loja_id=1 AND p.status='ENTREGUE'
    GROUP BY p.cliente_whatsapp, c.nome ORDER BY compras DESC, nome LIMIT ?`, limite);
}

async function resgatarManual(premioId, pedidoId) {
  const p = await get('SELECT * FROM fidelidade_premios WHERE id=?', premioId);
  if (!p) return { ok: false, erro: 'Prêmio não encontrado.' };
  if (p.status !== 'disponivel') return { ok: false, erro: 'Este prêmio já foi resolvido.' };
  await run("UPDATE fidelidade_premios SET status='resgatado', pedido_resgate_id=COALESCE(?, pedido_resgate_id), resgatado_em=datetime('now') WHERE id=?", pedidoId || null, premioId);
  return { ok: true };
}

async function removerPremio(premioId) {
  await run('DELETE FROM fidelidade_premios WHERE id=?', premioId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sorteio de promoções (v1.9.18 — fase 2 da fidelidade, ideia do Gabriel).
// Participa quem tem compra ENTREGUE no período; cada compra = 1 chance.
// O ganhador recebe um vale (prêmio avulso de fidelidade) automaticamente.
// ---------------------------------------------------------------------------
const { randomInt } = require('crypto');

// Vale avulso (sorteio, cortesia...): nasce como prêmio personalizado
// disponível; aparece na tela do cliente e na lista de prêmios do painel.
async function concederPremioAvulso(whatsapp, nome, texto) {
  const w = normalizaFone(whatsapp);
  const marco = await contarEntregues(w);
  await run(`INSERT INTO fidelidade_premios (loja_id, whatsapp, cliente_nome, marco_compras, premio_tipo, premio_texto, pedido_origem_id)
    VALUES (1, ?, ?, ?, 'personalizado', ?, NULL)`, w, nome || null, marco, String(texto || 'Prêmio').slice(0, 120));
}

// Participantes do período [ini, fim] ('YYYY-MM-DD'): 1 chance por compra.
// ATENÇÃO ao fuso: pedidos.created_at é UTC, mas o período é a data LOCAL da
// loja (Brasília, UTC-3) — os limites são deslocados +3h, senão a compra das
// 21h de hoje (00h UTC de amanhã) caía fora do "este mês".
async function participantes(ini, fim) {
  const iniTs = ini ? `${ini} 03:00:00` : '0001-01-01 00:00:00';
  let fimTs = '9999-12-31 23:59:59';
  if (fim) {
    const d = new Date(`${fim}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    fimTs = d.toISOString().slice(0, 10) + ' 03:00:00';
  }
  return all(`SELECT p.cliente_whatsapp AS whatsapp, COALESCE(c.nome, MAX(p.cliente_nome)) AS nome,
      COUNT(*) AS compras
    FROM pedidos p LEFT JOIN clientes c ON c.loja_id=1 AND c.whatsapp = p.cliente_whatsapp
    WHERE p.loja_id=1 AND p.status='ENTREGUE' AND p.created_at >= ? AND p.created_at < ?
    GROUP BY p.cliente_whatsapp, c.nome ORDER BY compras DESC, nome`, iniTs, fimTs);
}

/* Sorteio DIVULGADO (v1.16.9 — pedido do Gabriel): o certo e CRIAR o
   sorteio primeiro; ele fica ATIVO, e anunciado pros clientes na
   vitrine e na finalizacao da compra. O sorteio em si (escolher o
   ganhador) acontece depois, quando o dono mandar, sobre o periodo
   guardado na criacao. */
async function sorteioAtivo() {
  return get(`SELECT * FROM sorteios WHERE loja_id=1 AND status='ativo' ORDER BY id DESC LIMIT 1`);
}

async function sorteioPorId(id) {
  return get(`SELECT * FROM sorteios WHERE loja_id=1 AND id=?`, id);
}

async function criarSorteio({ titulo, premio_texto }) {
  const tit = String(titulo || '').trim().slice(0, 80);
  const premio = String(premio_texto || '').trim().slice(0, 120);
  if (!tit) return { ok: false, erro: 'Dê um título ao sorteio (ex.: Sorteio de Aniversário).' };
  if (!premio) return { ok: false, erro: 'Escreva o prêmio (ex.: 1 Combo Guri Bão grátis).' };
  const ativo = await sorteioAtivo();
  if (ativo) return { ok: false, erro: `Já existe um sorteio sendo divulgado ("${ativo.titulo}"). Sorteie ou encerre ele primeiro.` };
  // Sem periodo escolhido (regra do Gabriel, v1.16.11): o periodo do
  // sorteio e' a propria vida dele — da criacao (criado_em) ate o
  // sorteio/encerramento. So contam compras feitas nesse intervalo.
  const info = await run(`INSERT INTO sorteios (loja_id, titulo, premio_texto, periodo_ini, periodo_fim, status)
    VALUES (1, ?, ?, NULL, NULL, 'ativo')`,
    tit, premio);
  const id = Number(info && info.lastInsertRowid) || null;
  return { ok: true, sorteio: await get(`SELECT * FROM sorteios WHERE loja_id=1 AND id=?`, id) };
}

/* Participantes PELA REGRA DO SORTEIO ATIVO (v1.16.11): so compras
   CRIADAS a partir do momento em que o sorteio foi criado (criado_em
   da linha) e ja ENTREGUES. Compra de antes — mesmo entregue durante
   o sorteio — NAO entra; a comparacao e' feita no banco, entre as
   duas colunas de data, pra valer igual nos dois bancos. */
async function participantesDoSorteio(s) {
  return all(`SELECT p.cliente_whatsapp AS whatsapp, COALESCE(c.nome, MAX(p.cliente_nome)) AS nome,
      COUNT(*) AS compras
    FROM pedidos p LEFT JOIN clientes c ON c.loja_id=1 AND c.whatsapp = p.cliente_whatsapp
    WHERE p.loja_id=1 AND p.status='ENTREGUE'
      AND p.created_at >= (SELECT criado_em FROM sorteios WHERE id=?)
    GROUP BY p.cliente_whatsapp, c.nome ORDER BY compras DESC, nome`, s.id);
}

async function encerrarSorteio(id) {
  const s = await get(`SELECT * FROM sorteios WHERE loja_id=1 AND id=?`, id);
  if (!s) return { ok: false, erro: 'Sorteio não encontrado.' };
  if (s.status !== 'ativo') return { ok: false, erro: 'Este sorteio não está ativo.' };
  await run(`UPDATE sorteios SET status='encerrado' WHERE id=?`, id);
  return { ok: true };
}

async function sortearAgora(id) {
  const s = await get(`SELECT * FROM sorteios WHERE loja_id=1 AND id=?`, id);
  if (!s) return { ok: false, erro: 'Sorteio não encontrado.' };
  if (s.status !== 'ativo') return { ok: false, erro: 'Este sorteio já foi encerrado.' };
  const tit = s.titulo;
  const premio = s.premio_texto;
  const parts = await participantesDoSorteio(s);
  if (!parts.length) return { ok: false, erro: 'Ainda ninguém comprou com o sorteio ativo. Espere entrarem compras entregues desde a criação dele.' };
  const totalChances = parts.reduce((soma, p) => soma + Number(p.compras), 0);
  let sorteado = randomInt(0, totalChances);
  let ganhador = parts[0];
  for (const p of parts) {
    if (sorteado < Number(p.compras)) { ganhador = p; break; }
    sorteado -= Number(p.compras);
  }
  await run(`UPDATE sorteios SET status='sorteado', total_clientes=?, total_chances=?, ganhador_whatsapp=?, ganhador_nome=?, ganhador_chances=? WHERE id=?`,
    parts.length, totalChances, ganhador.whatsapp, ganhador.nome || null, Number(ganhador.compras), s.id);
  // O vale nasce na hora (vale também se o programa estiver desligado — o
  // anúncio principal é a mensagem direta; o vale aparece quando ativo).
  try { await concederPremioAvulso(ganhador.whatsapp, ganhador.nome, `${tit}: ${premio}`); } catch { /* vale é bônus */ }
  try {
    await notif.notificarDonoTexto(
      `🎲 *Sorteio realizado:* ${notif.escMd(tit)}\nPrêmio: ${notif.escMd(premio)}\nGanhador(a): ${notif.escMd(ganhador.nome || 'Cliente')} (${ganhador.whatsapp}) — ${ganhador.compras} compra(s) no período, de ${parts.length} participante(s).\nO vale já foi criado no nome dele(a). É só chamar no WhatsApp e comemorar!`);
  } catch { /* idem */ }
  return {
    ok: true, sorteio_id: s.id,
    ganhador: { nome: ganhador.nome || 'Cliente', whatsapp: ganhador.whatsapp, chances: Number(ganhador.compras) },
    total_clientes: parts.length, total_chances: totalChances,
    participantes: parts.map(p => ({ nome: p.nome || 'Cliente', chances: Number(p.compras) })),
  };
}

// Compatibilidade: criar e sortear no mesmo passo.
async function sortear(dados) {
  const c = await criarSorteio(dados);
  if (!c.ok) return c;
  return sortearAgora(c.sorteio.id);
}

async function listarSorteios() {
  return all('SELECT * FROM sorteios WHERE loja_id=1 ORDER BY id DESC LIMIT 30');
}

module.exports = {
  preparar, criarTabelas, getConfig, salvarConfig, statusCliente,
  premioResgatavel, consumirPremio, aoTransicionar,
  listarPremios, ranking, resgatarManual, removerPremio, TEXTO_ENTREGA_GRATIS,
  participantes, sortear, listarSorteios, concederPremioAvulso,
  sorteioAtivo, sorteioPorId, criarSorteio, encerrarSorteio, sortearAgora, participantesDoSorteio,
};
