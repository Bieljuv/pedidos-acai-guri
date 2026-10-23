'use strict';
// Cupons de desconto (v1.14.0 — ideia vinda da Anota AI).
// A loja cria códigos (ex.: BEMVINDO10) com desconto percentual ou fixo,
// valor mínimo, validade e limite de usos. O cliente digita o código no
// checkout; a validação de verdade acontece SEMPRE no servidor, na criação
// do pedido (o desconto cai sobre o subtotal, nunca sobre a taxa).
const { get, all, run, execSql, modoBanco } = require('./db');
const tenant = require('./tenant');

const lid = () => tenant.lojaId();

async function criarTabelas() {
  if (modoBanco() === 'sqlite') {
    await execSql(`
CREATE TABLE IF NOT EXISTS cupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id INTEGER NOT NULL DEFAULT 1,
  codigo TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'percentual',
  valor INTEGER NOT NULL DEFAULT 0,
  minimo_centavos INTEGER NOT NULL DEFAULT 0,
  expira_em TEXT,
  usos_max INTEGER,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cupons_loja_codigo ON cupons (loja_id, codigo);
`);
  } else {
    await execSql(`
CREATE TABLE IF NOT EXISTS cupons (
  id SERIAL PRIMARY KEY,
  loja_id INTEGER NOT NULL DEFAULT 1,
  codigo TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'percentual',
  valor INTEGER NOT NULL DEFAULT 0,
  minimo_centavos INTEGER NOT NULL DEFAULT 0,
  expira_em TEXT,
  usos_max INTEGER,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cupons_loja_codigo ON cupons (loja_id, codigo);
`);
  }
}

async function preparar() {
  try { await criarTabelas(); } catch (e) { console.error('[cupons] preparar:', e.message); }
}

const normalizaCodigo = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);

function hojeLocal() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

async function usosDoCupom(codigo) {
  const r = await get(`SELECT COUNT(*) c FROM pedidos WHERE loja_id=${lid()} AND cupom_codigo=? AND status<>'CANCELADO'`, codigo);
  return Number(r && r.c) || 0;
}

async function buscar(codigo) {
  return (await get(`SELECT * FROM cupons WHERE loja_id=${lid()} AND codigo=?`, normalizaCodigo(codigo))) || null;
}

// Valida e calcula o desconto sobre o subtotal. Retorna {ok, desconto} ou
// {ok:false, erro} com a mensagem que o cliente pode ler.
async function validar(codigoBruto, subtotal) {
  const codigo = normalizaCodigo(codigoBruto);
  if (!codigo) return { ok: false, erro: 'Digite o código do cupom.' };
  const c = await buscar(codigo);
  if (!c || !c.ativo) return { ok: false, erro: 'Cupom inválido ou expirado.' };
  if (c.expira_em && c.expira_em < hojeLocal()) return { ok: false, erro: 'Este cupom já expirou.' };
  if (Number(c.minimo_centavos) > 0 && subtotal < Number(c.minimo_centavos)) {
    return { ok: false, erro: `Este cupom vale em pedidos a partir de R$ ${(Number(c.minimo_centavos) / 100).toFixed(2).replace('.', ',')}.` };
  }
  if (c.usos_max != null) {
    const usos = await usosDoCupom(codigo);
    if (usos >= Number(c.usos_max)) return { ok: false, erro: 'Este cupom atingiu o limite de usos.' };
  }
  let desconto = c.tipo === 'percentual'
    ? Math.floor(subtotal * Math.min(100, Math.max(1, Number(c.valor) || 0)) / 100)
    : Math.min(Number(c.valor) || 0, subtotal);
  desconto = Math.max(0, Math.min(desconto, subtotal));
  if (desconto <= 0) return { ok: false, erro: 'Este cupom não gera desconto neste pedido.' };
  return { ok: true, cupom: c, desconto };
}

async function listar() {
  const lista = await all(`SELECT * FROM cupons WHERE loja_id=${lid()} ORDER BY id DESC LIMIT 100`);
  for (const c of lista) c.usos = await usosDoCupom(c.codigo);
  return lista;
}

async function criar(dados) {
  const codigo = normalizaCodigo(dados.codigo);
  if (codigo.length < 3) return { ok: false, erro: 'O código precisa de pelo menos 3 letras/números.' };
  const tipo = dados.tipo === 'fixo' ? 'fixo' : 'percentual';
  const valor = Math.round(Number(dados.valor) || 0);
  if (valor <= 0) return { ok: false, erro: tipo === 'percentual' ? 'Informe o percentual de desconto.' : 'Informe o valor do desconto.' };
  if (tipo === 'percentual' && valor > 100) return { ok: false, erro: 'O percentual máximo é 100%.' };
  if (await buscar(codigo)) return { ok: false, erro: 'Já existe um cupom com este código.' };
  const minimo = Math.max(0, Math.round(Number(dados.minimo_centavos) || 0));
  const expira = dados.expira_em && /^\d{4}-\d{2}-\d{2}$/.test(String(dados.expira_em)) ? String(dados.expira_em) : null;
  const usosMax = dados.usos_max != null && Number(dados.usos_max) > 0 ? Math.round(Number(dados.usos_max)) : null;
  const info = await run(`INSERT INTO cupons (loja_id, codigo, tipo, valor, minimo_centavos, expira_em, usos_max)
    VALUES (${lid()}, ?, ?, ?, ?, ?, ?)`, codigo, tipo, valor, minimo, expira, usosMax);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

async function definirAtivo(id, ativo) {
  await run(`UPDATE cupons SET ativo=? WHERE id=? AND loja_id=${lid()}`, ativo ? 1 : 0, Number(id));
  return { ok: true };
}

async function remover(id) {
  await run(`DELETE FROM cupons WHERE id=? AND loja_id=${lid()}`, Number(id));
  return { ok: true };
}

module.exports = { preparar, validar, listar, criar, definirAtivo, remover, normalizaCodigo };
