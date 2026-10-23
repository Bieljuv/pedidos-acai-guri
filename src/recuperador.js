'use strict';
// Recuperador de vendas (v1.14.0 — recurso-assinatura da Anota AI e da
// Multipedidos). O checkout avisa o servidor quando um cliente identificado
// monta um pedido e não finaliza ("intenção"). Passado o tempo configurado
// sem o pedido nascer, o sistema chama o cliente no WhatsApp (pela fila de
// notificações: Evolution quando configurado; senão fica registrado como
// simulado) e a intenção aparece no painel com botão de chamar вручную.
// O carrinho mora no aparelho do cliente (localStorage) — ao voltar à loja,
// ele reencontra tudo montado; a mensagem só precisa trazê-lo de volta.
const { get, all, run, execSql, modoBanco } = require('./db');
const tenant = require('./tenant');
const { normalizaFone } = require('./util');

const lid = () => tenant.lojaId();

const MSG_PADRAO = 'Oi, {nome}! Aqui é da {loja} 😊 Você montou um pedido e não finalizou — ele ficou guardadinho no seu aparelho, é só voltar na loja e concluir. Qualquer dúvida é só chamar!';

async function criarTabelas() {
  const ddlIntencoes = modoBanco() === 'sqlite' ? `
CREATE TABLE IF NOT EXISTS intencoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id INTEGER NOT NULL DEFAULT 1,
  whatsapp TEXT NOT NULL,
  nome TEXT,
  itens_json TEXT,
  total_centavos INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT DEFAULT (datetime('now')),
  atualizado_em TEXT DEFAULT (datetime('now')),
  convertido_pedido_id INTEGER,
  avisado_em TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intencoes_loja_whats ON intencoes (loja_id, whatsapp);
CREATE TABLE IF NOT EXISTS config_recuperador (
  id INTEGER PRIMARY KEY,
  loja_id INTEGER NOT NULL DEFAULT 1,
  ativo INTEGER NOT NULL DEFAULT 1,
  minutos INTEGER NOT NULL DEFAULT 30,
  mensagem TEXT
);
` : `
CREATE TABLE IF NOT EXISTS intencoes (
  id SERIAL PRIMARY KEY,
  loja_id INTEGER NOT NULL DEFAULT 1,
  whatsapp TEXT NOT NULL,
  nome TEXT,
  itens_json TEXT,
  total_centavos INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ DEFAULT now(),
  convertido_pedido_id INTEGER,
  avisado_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intencoes_loja_whats ON intencoes (loja_id, whatsapp);
CREATE TABLE IF NOT EXISTS config_recuperador (
  id INTEGER PRIMARY KEY,
  loja_id INTEGER NOT NULL DEFAULT 1,
  ativo INTEGER NOT NULL DEFAULT 1,
  minutos INTEGER NOT NULL DEFAULT 30,
  mensagem TEXT
);
`;
  await execSql(ddlIntencoes);
}

async function preparar() {
  try {
    await criarTabelas();
    await run(`INSERT OR IGNORE INTO config_recuperador (id, loja_id) VALUES (${lid()}, ${lid()})`);
  } catch (e) { console.error('[recuperador] preparar:', e.message); }
}

async function getConfig() {
  const c = (await get(`SELECT * FROM config_recuperador WHERE id=${lid()}`)) || {};
  return {
    ativo: c.ativo === undefined ? true : !!c.ativo,
    minutos: Math.min(240, Math.max(5, Number(c.minutos) || 30)),
    mensagem: c.mensagem || MSG_PADRAO,
  };
}

async function salvarConfig(dados) {
  const atual = await getConfig();
  const prox = {
    ativo: dados.ativo !== undefined ? (dados.ativo ? 1 : 0) : (atual.ativo ? 1 : 0),
    minutos: dados.minutos !== undefined ? Math.min(240, Math.max(5, Number(dados.minutos) || 30)) : atual.minutos,
    mensagem: dados.mensagem !== undefined ? String(dados.mensagem || '').trim().slice(0, 500) || null : null,
  };
  await run(`INSERT INTO config_recuperador (id, loja_id, ativo, minutos, mensagem)
    VALUES (${lid()}, ${lid()}, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET ativo=excluded.ativo, minutos=excluded.minutos, mensagem=excluded.mensagem`,
    prox.ativo, prox.minutos, prox.mensagem);
  return getConfig();
}

// O checkout registra/atualiza a intenção (1 linha por cliente e loja).
async function registrar(dados) {
  const w = normalizaFone(dados.whatsapp);
  if (!w || w.length < 12) return { ok: false };
  const itens = Array.isArray(dados.itens) ? dados.itens.slice(0, 30).map(i => ({
    nome: String(i.nome || 'Item').slice(0, 80), quantidade: Math.max(1, Math.min(99, Number(i.quantidade) || 1)),
  })) : [];
  if (!itens.length) return { ok: false };
  const total = Math.max(0, Math.round(Number(dados.total_centavos) || 0));
  const nome = String(dados.nome || '').trim().slice(0, 80) || null;
  const existente = await get(`SELECT id, convertido_pedido_id FROM intencoes WHERE loja_id=${lid()} AND whatsapp=?`, w);
  if (existente && existente.convertido_pedido_id) {
    // já comprou depois da última intenção: começa um ciclo novo
    await run(`UPDATE intencoes SET nome=?, itens_json=?, total_centavos=?, atualizado_em=datetime('now'), convertido_pedido_id=NULL, avisado_em=NULL WHERE id=?`,
      nome, JSON.stringify(itens), total, existente.id);
  } else if (existente) {
    await run(`UPDATE intencoes SET nome=?, itens_json=?, total_centavos=?, atualizado_em=datetime('now'), avisado_em=NULL WHERE id=?`,
      nome, JSON.stringify(itens), total, existente.id);
  } else {
    await run(`INSERT INTO intencoes (loja_id, whatsapp, nome, itens_json, total_centavos) VALUES (${lid()}, ?, ?, ?, ?)`,
      w, nome, JSON.stringify(itens), total);
  }
  return { ok: true };
}

async function marcarConvertido(whatsapp, pedidoId) {
  const w = normalizaFone(whatsapp);
  if (!w) return;
  await run(`UPDATE intencoes SET convertido_pedido_id=? WHERE loja_id=${lid()} AND whatsapp=? AND convertido_pedido_id IS NULL`, pedidoId, w);
}

function instante(v) {
  if (!v) return null;
  const s = String(v);
  const d = new Date(s.includes('T') || s.includes('+') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d;
}

// Pendentes: montou, não comprou, dentro das últimas 48h.
async function pendentes() {
  const rows = await all(`SELECT * FROM intencoes WHERE loja_id=${lid()} AND convertido_pedido_id IS NULL ORDER BY atualizado_em DESC LIMIT 100`);
  const limite = Date.now() - 48 * 3600 * 1000;
  return rows.filter(r => { const d = instante(r.atualizado_em); return d && d.getTime() > limite; })
    .map(r => ({ ...r, itens: (() => { try { return JSON.parse(r.itens_json || '[]'); } catch { return []; } })() }));
}

async function varrer() {
  const cfg = await getConfig();
  if (!cfg.ativo) return;
  const loja = await get(`SELECT nome FROM lojas WHERE id=${lid()}`);
  const nomeLoja = (loja && loja.nome) || 'loja';
  const lista = await pendentes();
  const agora = Date.now();
  for (const it of lista) {
    if (it.avisado_em) continue;
    const d = instante(it.atualizado_em);
    if (!d || agora - d.getTime() < cfg.minutos * 60 * 1000) continue;
    const primeiroNome = String(it.nome || 'cliente').split(' ')[0];
    const texto = cfg.mensagem.replaceAll('{nome}', primeiroNome).replaceAll('{loja}', nomeLoja);
    try {
      const notif = require('./notificacoes');
      await notif.enfileirar({ canal: 'whatsapp', destino: it.whatsapp, corpo: texto });
      await run(`UPDATE intencoes SET avisado_em=datetime('now') WHERE id=?`, it.id);
    } catch (e) { console.error('[recuperador] varrer:', e.message); }
  }
}

let iniciado = false;
function iniciar() {
  if (iniciado) return;
  iniciado = true;
  setInterval(async () => {
    try {
      const lojas = await all('SELECT id FROM lojas');
      for (const l of lojas) await tenant.como(l.id, () => varrer());
    } catch (e) { console.error('[recuperador] varredura:', e.message); }
  }, 60 * 1000);
}

module.exports = { preparar, iniciar, getConfig, salvarConfig, registrar, marcarConvertido, pendentes, varrer, MSG_PADRAO };
