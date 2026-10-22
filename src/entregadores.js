'use strict';
// Integração com a 99 (99POP) — chamar entregador pelo painel.
// ---------------------------------------------------------------------------
// A API da 99 para parceiros (99POP) é liberada para parceiros credenciados e o
// contrato pode mudar; por isso TUDO que é específico da 99 vive neste arquivo:
//
//   POST {base}/oauth/token               -> token OAuth2 (client_credentials)
//   POST {base}/requests                   -> cria o pedido de entrega
//   GET  {base}/requests/{codigo}          -> consulta o status
//   POST {base}/requests/{codigo}/cancel   -> cancela o pedido
//
// Se a 99 mudar rota ou nome de campo, ajuste aqui (api99 / montarPayload99) e o
// resto do sistema não muda. A LEITURA da resposta é tolerante: aceita vários
// nomes de campo (id/requestId/codigo, price/valor/fee, courier/motoboy/driver),
// porque cada conta parceira pode receber nomes diferentes.
//
// Regras do sistema:
//   • Falhar ao chamar o entregador NUNCA trava o pedido — o dono recebe o aviso
//     e pode chamar por fora (telefone do entregador) ou tentar de novo.
//   • O segredo (client_secret) nunca volta inteiro para o painel.
//   • A configuração vive no BANCO (tabela config_entregadores, linha única id=1),
//     com fallback campo a campo para o .env do servidor.
const { get, all, run, execSql, modoBanco } = require('./db');
const notif = require('./notificacoes');

const CANAL = '99pop';
const API_BASE_PADRAO = 'https://openapi.99pop.com.br';

// ---------------------------------------------------------------------------
// Tabelas — criadas no preparar() (depois do boot do banco), não na carga do
// módulo, para não depender da ordem em que o servidor abre a conexão.
// ---------------------------------------------------------------------------
async function criarTabelas() {
  if (modoBanco() === 'sqlite') {
    await execSql(`
CREATE TABLE IF NOT EXISTS config_entregadores (
  id INTEGER PRIMARY KEY,
  loja_id INTEGER NOT NULL DEFAULT 1,
  canal TEXT NOT NULL DEFAULT '99pop',
  ativo INTEGER NOT NULL DEFAULT 0,
  api_base TEXT NOT NULL DEFAULT '${API_BASE_PADRAO}',
  client_id TEXT,
  client_secret TEXT,
  merchant_id TEXT,
  merchant_name TEXT,
  merchant_document TEXT,
  pickup_json TEXT NOT NULL DEFAULT '{}',
  pickup_phone TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS entregas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id INTEGER NOT NULL DEFAULT 1,
  pedido_id INTEGER NOT NULL,
  canal TEXT NOT NULL DEFAULT '99pop',
  codigo_externo TEXT,
  status TEXT NOT NULL DEFAULT 'solicitado',
  status_99 TEXT,
  entregador TEXT,
  telefone TEXT,
  preco_centavos INTEGER,
  previsao TEXT,
  motivo TEXT,
  resposta_json TEXT NOT NULL DEFAULT '{}',
  criado_em TEXT DEFAULT (datetime('now')), atualizado_em TEXT DEFAULT (datetime('now'))
);
`);
  } else {
    // Postgres: SERIAL no lugar de AUTOINCREMENT (o dialeto do SQLite não roda lá).
    await execSql(`
CREATE TABLE IF NOT EXISTS config_entregadores (
  id INTEGER PRIMARY KEY,
  loja_id INTEGER NOT NULL DEFAULT 1,
  canal TEXT NOT NULL DEFAULT '99pop',
  ativo INTEGER NOT NULL DEFAULT 0,
  api_base TEXT NOT NULL DEFAULT '${API_BASE_PADRAO}',
  client_id TEXT,
  client_secret TEXT,
  merchant_id TEXT,
  merchant_name TEXT,
  merchant_document TEXT,
  pickup_json TEXT NOT NULL DEFAULT '{}',
  pickup_phone TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entregas (
  id SERIAL PRIMARY KEY,
  loja_id INTEGER NOT NULL DEFAULT 1,
  pedido_id INTEGER NOT NULL,
  canal TEXT NOT NULL DEFAULT '99pop',
  codigo_externo TEXT,
  status TEXT NOT NULL DEFAULT 'solicitado',
  status_99 TEXT,
  entregador TEXT,
  telefone TEXT,
  preco_centavos INTEGER,
  previsao TEXT,
  motivo TEXT,
  resposta_json TEXT NOT NULL DEFAULT '{}',
  criado_em TIMESTAMPTZ DEFAULT now(), atualizado_em TIMESTAMPTZ DEFAULT now()
);
`);
  }
}

// ---------------------------------------------------------------------------
// Configuração (banco -> fallback .env)
// ---------------------------------------------------------------------------
let cfgCache = null;
let linhaCache = {};

function mascarar(segredo) {
  if (!segredo) return '';
  const s = String(segredo);
  return s.length <= 4 ? '••••' : '••••' + s.slice(-4);
}

async function linhaCfg() {
  try { return (await get('SELECT * FROM config_entregadores WHERE id=1')) || {}; } catch { return {}; }
}
async function preparar() {
  try {
    // v1.9.4: criarTabelas precisa de await — no Postgres o execSql é async
    // e, sem esperar, o INSERT abaixo corria antes das tabelas existirem
    // ('relation "config_entregadores" does not exist' no log do boot).
    await criarTabelas();
    await run('INSERT OR IGNORE INTO config_entregadores (id, loja_id) VALUES (1, 1)');
    linhaCache = await linhaCfg();
    cfgCache = null;
  } catch (e) { console.error('[entregadores] config:', e.message); }
}
function getCfg() {
  if (cfgCache) return cfgCache;
  const db = linhaCache || {};
  const pick = (valorBanco, valorEnv) => {
    const v = valorBanco != null ? String(valorBanco).trim() : '';
    if (v) return { valor: v, origem: 'banco' };
    const e = String(valorEnv || '').trim();
    return { valor: e, origem: e ? 'env' : null };
  };
  const base = pick(db.api_base, process.env.NOVE9_API_BASE);
  const cid = pick(db.client_id, process.env.NOVE9_CLIENT_ID);
  const csec = pick(db.client_secret, process.env.NOVE9_CLIENT_SECRET);
  const mid = pick(db.merchant_id, process.env.NOVE9_MERCHANT_ID);
  const mname = pick(db.merchant_name, process.env.NOVE9_MERCHANT_NAME);
  const mdoc = pick(db.merchant_document, process.env.NOVE9_MERCHANT_DOCUMENT);
  const fone = pick(db.pickup_phone, process.env.NOVE9_PICKUP_PHONE);
  let pickup = {};
  try { pickup = JSON.parse(db.pickup_json || '{}') || {}; } catch { pickup = {}; }
  if (!Object.keys(pickup).length && process.env.NOVE9_PICKUP_JSON) {
    try { pickup = JSON.parse(process.env.NOVE9_PICKUP_JSON) || {}; } catch { pickup = {}; }
  }
  cfgCache = {
    canal: CANAL,
    ativo: db.ativo == null ? 0 : Number(db.ativo),
    apiBase: base.valor || API_BASE_PADRAO, apiBaseOrigem: base.origem,
    clientId: cid.valor, clientIdOrigem: cid.origem,
    clientSecret: csec.valor, clientSecretOrigem: csec.origem,
    merchantId: mid.valor, merchantIdOrigem: mid.origem,
    merchantName: mname.valor, merchantNameOrigem: mname.origem,
    merchantDocument: mdoc.valor, merchantDocumentOrigem: mdoc.origem,
    pickup, pickupPhone: fone.valor, pickupPhoneOrigem: fone.origem,
  };
  return cfgCache;
}
function invalidarCfg() { cfgCache = null; }

function cfgPublica() {
  const c = getCfg();
  const completo = !!(c.clientId && c.clientSecret);
  return {
    canal: CANAL,
    ativo: c.ativo !== 0,
    completo,
    configurado: completo && c.ativo !== 0,
    api_base: c.apiBase, api_base_origem: c.apiBaseOrigem,
    client_id: c.clientId, client_id_origem: c.clientIdOrigem,
    client_secret_configurado: !!c.clientSecret,
    client_secret_mascarado: mascarar(c.clientSecret),
    client_secret_origem: c.clientSecretOrigem,
    merchant_id: c.merchantId, merchant_id_origem: c.merchantIdOrigem,
    merchant_name: c.merchantName,
    merchant_document: c.merchantDocument,
    pickup: c.pickup || {},
    pickup_phone: c.pickupPhone, pickup_phone_origem: c.pickupPhoneOrigem,
  };
}

// Salvar: segredo em branco = MANTÉM o salvo; limpar_client_secret = apaga.
async function salvarCfg(dados = {}) {
  const atual = await linhaCfg();
  const comoBool = (v) => (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
  const prox = {
    ativo: atual.ativo == null ? 0 : Number(atual.ativo),
    api_base: atual.api_base || API_BASE_PADRAO,
    client_id: atual.client_id || null,
    client_secret: atual.client_secret || null,
    merchant_id: atual.merchant_id || null,
    merchant_name: atual.merchant_name || null,
    merchant_document: atual.merchant_document || null,
    pickup_json: atual.pickup_json || '{}',
    pickup_phone: atual.pickup_phone || null,
  };
  if (dados.ativo !== undefined) prox.ativo = comoBool(dados.ativo);
  if (dados.api_base !== undefined) {
    const base = String(dados.api_base || '').trim().replace(/\/+$/, '');
    if (base && !/^https?:\/\//i.test(base)) {
      return { ok: false, status: 422, erro: 'O endereço da API da 99 precisa começar com http:// ou https://.' };
    }
    prox.api_base = base || API_BASE_PADRAO;
  }
  if (dados.client_id !== undefined) prox.client_id = String(dados.client_id || '').trim() || null;
  if (dados.merchant_id !== undefined) prox.merchant_id = String(dados.merchant_id || '').trim() || null;
  if (dados.merchant_name !== undefined) prox.merchant_name = String(dados.merchant_name || '').trim() || null;
  if (dados.merchant_document !== undefined) prox.merchant_document = String(dados.merchant_document || '').trim() || null;
  if (dados.pickup_phone !== undefined) prox.pickup_phone = String(dados.pickup_phone || '').trim() || null;
  if (dados.pickup !== undefined) {
    const p = dados.pickup || {};
    const rua = String(p.logradouro || p.rua || '').trim();
    const numero = String(p.numero || '').trim();
    if (rua && !numero) {
      return { ok: false, status: 422, erro: 'Informe o número do endereço de retirada da loja.' };
    }
    prox.pickup_json = JSON.stringify({
      logradouro: rua, numero,
      complemento: String(p.complemento || '').trim(),
      bairro: String(p.bairro || '').trim(),
      cidade: String(p.cidade || '').trim(),
      uf: String(p.uf || '').trim().toUpperCase(),
      cep: String(p.cep || '').trim(),
      referencia: String(p.referencia || '').trim(),
    });
  }
  const querLimpar = (v) => v === true || v === 1 || v === '1' || v === 'true';
  if (querLimpar(dados.limpar_client_secret)) prox.client_secret = null;
  else if (typeof dados.client_secret === 'string' && dados.client_secret.trim()) prox.client_secret = dados.client_secret.trim();

  await run('INSERT OR IGNORE INTO config_entregadores (id, loja_id) VALUES (1, 1)');
  await run(`UPDATE config_entregadores SET ativo=?, api_base=?, client_id=?, client_secret=?,
      merchant_id=?, merchant_name=?, merchant_document=?, pickup_json=?, pickup_phone=?, updated_at=datetime('now') WHERE id=1`,
    prox.ativo, prox.api_base, prox.client_id, prox.client_secret,
    prox.merchant_id, prox.merchant_name, prox.merchant_document, prox.pickup_json, prox.pickup_phone);
  linhaCache = await linhaCfg();
  invalidarCfg();
  return { ok: true, cfg: cfgPublica() };
}

// ---------------------------------------------------------------------------
// Token OAuth2 (fica em memória; some quando o servidor reinicia)
// ---------------------------------------------------------------------------
let tokenCache = null; // { token, expiraEm }

function querLimparToken() { tokenCache = null; }

async function pedirToken() {
  const c = getCfg();
  if (!c.clientId || !c.clientSecret) throw new Error('A 99 nao esta configurada (Client ID e Client Secret).');
  const base = String(c.apiBase).replace(/\/+$/, '');
  const corpo = { client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'client_credentials' };
  let resp = null, json = null;
  // A 99 aceita JSON; alguns gateways de parceiro aceitam form-urlencoded.
  // Tentamos JSON e, se recusarem (400/415), tentamos o formato de formulário.
  try {
    resp = await fetch(base + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(15000),
    });
    json = await resp.json().catch(() => ({}));
  } catch {
    throw new Error('Nao consegui falar com a API da 99 agora (rede). Tente de novo em alguns segundos.');
  }
  if ((!resp.ok || !json || !json.access_token) && (resp.status === 400 || resp.status === 415)) {
    try {
      const form = new URLSearchParams(corpo);
      resp = await fetch(base + '/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form.toString(),
        signal: AbortSignal.timeout(15000),
      });
      json = await resp.json().catch(() => ({}));
    } catch { /* mantém o erro original */ }
  }
  if (!resp.ok || !json || !json.access_token) {
    const motivo = (json && (json.error_description || json.error || json.message)) || ('HTTP ' + resp.status);
    throw new Error('A 99 recusou a credencial: ' + String(motivo).slice(0, 200));
  }
  const segundos = Number(json.expires_in || 3600) || 3600;
  tokenCache = { token: String(json.access_token), expiraEm: Date.now() + (segundos * 1000) };
  return tokenCache.token;
}

async function tokenValido() {
  if (tokenCache && tokenCache.token && tokenCache.expiraEm > (Date.now() + 30000)) return tokenCache.token;
  return pedirToken();
}

// Chamada genérica na API da 99 (já com o token).
async function api99(metodo, caminho, corpo) {
  const c = getCfg();
  const base = String(c.apiBase).replace(/\/+$/, '');
  const token = await tokenValido();
  let resp = null, json = null;
  try {
    resp = await fetch(base + caminho, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error('A API da 99 nao respondeu (rede ou tempo limite).');
  }
  json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const motivo = (json && (json.message || json.error_description || json.error)) || ('HTTP ' + resp.status);
    // 401 = token expirado: limpa e deixa a proxima tentativa pedir um novo.
    if (resp.status === 401) querLimparToken();
    throw new Error('A 99 recusou a operacao: ' + String(motivo).slice(0, 200));
  }
  return json;
}

// ---------------------------------------------------------------------------
// Leitura tolerante da resposta + status
// ---------------------------------------------------------------------------
function normalizarResposta99(json) {
  const j = json || {};
  const raiz = (j.data || j.result || j.request || j);
  const r = raiz && typeof raiz === 'object' ? raiz : {};
  const primeiro = (...v) => { for (const x of v) { if (x !== undefined && x !== null && x !== '') return x; } return null; };
  const codigo = primeiro(r.id, r.requestId, r.request_id, r.codigo, r.code, r.trackingCode, r.tracking_code, r.protocolo);
  const status = primeiro(r.status, r.state, r.situation, r.statusDescription, r.situacao);
  const preco = primeiro(r.price, r.valor, r.amount, r.fee, r.total, r.deliveryFee, r.delivery_fee);
  const entregador = primeiro(
    r.courier && r.courier.name, r.motoboy && r.motoboy.name, r.driver && r.driver.name,
    r.deliverer && r.deliverer.name, r.courierName, r.motoboyName, r.driverName, r.entregador,
  );
  const telefone = primeiro(
    r.courier && r.courier.phone, r.motoboy && r.motoboy.phone, r.driver && r.driver.phone,
    r.deliverer && r.deliverer.phone, r.courierPhone, r.motoboyPhone, r.driverPhone, r.telefone,
  );
  const previsao = primeiro(
    r.estimatedDeliveryTime, r.estimated_delivery_time, r.previsao, r.eta, r.estimatedTime, r.deliveryTime,
  );
  let precoCentavos = null;
  if (preco !== null && preco !== undefined && preco !== '' && !Number.isNaN(Number(preco))) {
    const n = Number(preco);
    // A 99 trabalha em centavos; se vier com centavos (número quebrado), é valor em reais.
    precoCentavos = Number.isInteger(n) ? n : Math.round(n * 100);
  }
  return {
    codigo: codigo !== null ? String(codigo) : null,
    status: status !== null ? String(status) : null,
    statusInterno: traduzirStatus99(status),
    entregador: entregador ? String(entregador) : null,
    telefone: telefone ? String(telefone) : null,
    precoCentavos,
    previsao: previsao ? String(previsao) : null,
  };
}

// Traduz o status da 99 para o nosso vocabulário (por palavra-chave, porque cada
// conta parceira pode usar um vocabulário um pouco diferente).
function traduzirStatus99(s) {
  // APIs costumam devolver UPPER_SNAKE (ON_THE_WAY, WAITING_PICKUP...):
  // normaliza '_' pra espaço antes de casar as palavras-chave.
  const t = String(s || '').toLowerCase().replace(/_/g, ' ');
  if (!t) return null;
  if (/cancel|recus|declin/.test(t)) return 'cancelado';
  if (/entreg|delivered|completed/.test(t)) return 'entregue';
  if (/colet|pick|retir/.test(t)) return 'coletado';
  if (/transit|rota|caminho|a caminho|on the way|desloc/.test(t)) return 'em_rota';
  if (/aceit|aprov|confirm|assign/.test(t)) return 'aceito';
  if (/solicit|pend|creat|aguard|wait/.test(t)) return 'solicitado';
  return null;
}

const ROTULO_STATUS = {
  manual: 'Despacho manual (pelo app da 99)',
  solicitado: 'Solicitado à 99',
  aceito: 'Aceito pela 99',
  em_rota: 'Entregador a caminho',
  coletado: 'Coletado na loja',
  entregue: 'Entregue',
  cancelado: 'Cancelado',
  recusado: 'Recusado pela 99',
};
function rotuloStatus(s) { return ROTULO_STATUS[s] || s || 'solicitado'; }

// ---------------------------------------------------------------------------
// Payload da 99
// ---------------------------------------------------------------------------
function montarPayload99(pedido, itens, c) {
  let end = pedido.endereco_json || pedido.endereco || {};
  if (typeof end === 'string') { try { end = JSON.parse(end); } catch { end = {}; } }
  end = end || {};
  const p = c.pickup || {};
  // O checkout da loja coleta rua/número/complemento/referência + bairro. Cidade,
  // UF e CEP vêm da configuração de retirada (mesma cidade da loja).
  const enderecoCliente = {
    street: end.rua || '',
    number: end.numero || '',
    complement: end.complemento || '',
    neighborhood: pedido.bairro_nome || end.bairro || '',
    city: p.cidade || '',
    state: p.uf || '',
    postal_code: p.cep || '',
    reference: end.referencia || '',
  };
  const enderecoLoja = {
    street: p.logradouro || '',
    number: p.numero || '',
    complement: p.complemento || '',
    neighborhood: p.bairro || '',
    city: p.cidade || '',
    state: p.uf || '',
    postal_code: p.cep || '',
    reference: p.referencia || '',
  };
  return {
    merchant: {
      id: c.merchantId || null,
      name: c.merchantName || null,
      document: c.merchantDocument || null,
    },
    pickup: {
      name: c.merchantName || null,
      phone: c.pickupPhone || null,
      address: enderecoLoja,
    },
    recipient: {
      name: pedido.cliente_nome || null,
      phone: pedido.cliente_whatsapp || null,
      address: enderecoCliente,
    },
    order: {
      // O número do pedido para a 99 é o CÓDIGO DA ENTREGA gerado pelo sistema
      // (o mesmo que o cliente dita e que aparece na comanda). Assim os dois
      // lados são conciliados pelo mesmo identificador; o código que a 99
      // devolve fica guardado em entregas.codigo_externo.
      number: pedido.codigo_entrega || String(pedido.numero),
      total: pedido.total_centavos,
      payment_method: pedido.forma_pagamento || null,
      notes: pedido.observacao || null,
    },
    items: (itens || []).map((i) => ({
      description: i.nome_snapshot || '',
      quantity: Number(i.quantidade || 1),
      price: Number(i.subtotal_centavos || 0),
    })),
  };
}

// ---------------------------------------------------------------------------
// Fluxo: chamar / consultar / cancelar
// ---------------------------------------------------------------------------
async function despachar(pedido, itens) {
  const c = getCfg();
  if (c.ativo === 0) throw new Error('A integracao com a 99 esta desligada nas Configuracoes.');
  if (!c.clientId || !c.clientSecret) throw new Error('A 99 nao esta configurada (Client ID e Client Secret).');
  if (!c.merchantId) throw new Error('Falta o Merchant ID da 99 nas Configuracoes.');
  if (pedido.tipo !== 'entrega') throw new Error('Entregador so se chama em pedido de entrega.');
  const payload = montarPayload99(pedido, itens, c);
  const json = await api99('POST', '/requests', payload);
  const dados = normalizarResposta99(json);
  if (!dados.codigo) throw new Error('A 99 aceitou a chamada mas nao devolveu o codigo do pedido de entrega.');
  const status = dados.statusInterno || 'aceito';
  const info = await run(`INSERT INTO entregas (pedido_id, canal, codigo_externo, status, status_99, entregador, telefone, preco_centavos, previsao, resposta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    pedido.id, CANAL, dados.codigo, status, dados.status, dados.entregador, dados.telefone,
    dados.precoCentavos, dados.previsao, JSON.stringify(json || {}).slice(0, 4000));
  return {
    id: info.lastInsertRowid,
    pedido_id: pedido.id,
    codigo: dados.codigo,
    status,
    status_rotulo: rotuloStatus(status),
    entregador: dados.entregador,
    telefone: dados.telefone,
    preco_centavos: dados.precoCentavos,
    previsao: dados.previsao,
  };
}

// Despacho MANUAL (v1.9.2): sem credenciais ativas da 99, o painel monta os
// dados pra copiar pro app da 99 e o chamado fica registrado no histórico do
// pedido com status 'manual' — o PIN continua sendo o codigo_entrega.
async function registrarManual(pedido) {
  if (!pedido || pedido.tipo !== 'entrega') throw new Error('Entregador so se chama em pedido de entrega.');
  const info = await run(`INSERT INTO entregas (pedido_id, canal, codigo_externo, status, status_99, resposta_json)
      VALUES (?, ?, NULL, 'manual', NULL, ?)`,
    pedido.id, CANAL, JSON.stringify({ manual: true, pin: pedido.codigo_entrega || null, numero: pedido.numero }));
  const e = await get('SELECT * FROM entregas WHERE id=?', info.lastInsertRowid);
  return { ...e, status_rotulo: rotuloStatus('manual') };
}

async function entregasDoPedido(pedidoId) {
  try {
    const lista = await all('SELECT * FROM entregas WHERE pedido_id=? ORDER BY id DESC', pedidoId);
    return lista.map((e) => ({ ...e, status_rotulo: rotuloStatus(e.status) }));
  } catch { return []; }
}

async function entregaAtiva(pedidoId) {
  const lista = await entregasDoPedido(pedidoId);
  return lista.find((e) => e.status !== 'cancelado') || lista[0] || null;
}

async function consultar(entregaId) {
  const e = await get('SELECT * FROM entregas WHERE id=?', entregaId);
  if (!e) throw new Error('Entrega nao encontrada.');
  if (!e.codigo_externo) throw new Error('Esta entrega nao tem codigo na 99 para consultar.');
  const json = await api99('GET', '/requests/' + encodeURIComponent(e.codigo_externo));
  const dados = normalizarResposta99(json);
  const status = dados.statusInterno || e.status;
  await run(`UPDATE entregas SET status=?, status_99=?, entregador=?, telefone=?, preco_centavos=?, previsao=?, resposta_json=?, atualizado_em=datetime('now') WHERE id=?`,
    status, dados.status || e.status_99, dados.entregador || e.entregador, dados.telefone || e.telefone,
    dados.precoCentavos != null ? dados.precoCentavos : e.preco_centavos, dados.previsao || e.previsao,
    JSON.stringify(json || {}).slice(0, 4000), e.id);
  const atual = await get('SELECT * FROM entregas WHERE id=?', e.id);
  return { ...atual, status_rotulo: rotuloStatus(atual.status) };
}

async function cancelar(entregaId, motivo) {
  const e = await get('SELECT * FROM entregas WHERE id=?', entregaId);
  if (!e) throw new Error('Entrega nao encontrada.');
  if (!e.codigo_externo) throw new Error('Esta entrega nao tem codigo na 99 para cancelar.');
  await api99('POST', '/requests/' + encodeURIComponent(e.codigo_externo) + '/cancel', { reason: motivo || 'Cancelado pelo painel' });
  await run(`UPDATE entregas SET status='cancelado', motivo=?, atualizado_em=datetime('now') WHERE id=?`, motivo || 'Cancelado pelo painel', e.id);
  const atual = await get('SELECT * FROM entregas WHERE id=?', e.id);
  return { ...atual, status_rotulo: rotuloStatus(atual.status) };
}

// Webhook da 99: o pedido de entrega mudou de estado.
async function tratarWebhook(payload) {
  const dados = normalizarResposta99(payload);
  const j = payload || {};
  const codigo = dados.codigo || String(j.requestId || j.id || '') || null;
  if (!codigo) return { ok: false, motivo: 'Webhook sem identificador de pedido.' };
  const e = await get('SELECT * FROM entregas WHERE codigo_externo=? ORDER BY id DESC LIMIT 1', codigo);
  if (!e) return { ok: false, motivo: 'Nenhuma entrega deste sistema com o codigo ' + codigo + '.' };
  const status = dados.statusInterno || e.status;
  await run(`UPDATE entregas SET status=?, status_99=?, entregador=?, telefone=?, preco_centavos=?, previsao=?, resposta_json=?, atualizado_em=datetime('now') WHERE id=?`,
    status, dados.status || e.status_99, dados.entregador || e.entregador, dados.telefone || e.telefone,
    dados.precoCentavos != null ? dados.precoCentavos : e.preco_centavos, dados.previsao || e.previsao,
    JSON.stringify(payload || {}).slice(0, 4000), e.id);
  const atual = await get('SELECT * FROM entregas WHERE id=?', e.id);
  return { ok: true, entrega: { ...atual, status_rotulo: rotuloStatus(atual.status) }, status };
}

// Teste de credencial: pede token na 99 e mostra quem é a loja.
async function testar() {
  const c = getCfg();
  if (!c.clientId || !c.clientSecret) {
    return { ok: false, mensagem: 'A 99 nao esta configurada (Client ID e Client Secret).' };
  }
  try {
    await tokenValido();
    return {
      ok: true,
      mensagem: 'Credencial aceita pela 99.',
      api_base: c.apiBase,
      merchant_id: c.merchantId || null,
      merchant_name: c.merchantName || null,
    };
  } catch (e) {
    return { ok: false, mensagem: String(e.message || e) };
  }
}

// Aviso pro dono (Telegram) — a 99 não envia mensagem, então nós avisamos.
async function avisarDono(pedido, texto) {
  try { await notif.notificarDonoTexto(texto, pedido ? pedido.id : null); } catch { /* notificação nunca quebra */ }
}

module.exports = {
  CANAL, API_BASE_PADRAO, preparar, getCfg, invalidarCfg, cfgPublica, salvarCfg,
  despachar, registrarManual, consultar, cancelar, tratarWebhook, entregasDoPedido, entregaAtiva,
  rotuloStatus, traduzirStatus99, api99, tokenValido, testar,
  normalizarResposta99, montarPayload99,
};
