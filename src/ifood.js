'use strict';
// iFood — integração oficial (revisão de autenticação v1.16.0,
// conferida na documentação oficial em 23/10/2026).
//
// Existem DOIS modelos de app no iFood, e o produto é INTEGRADOR
// (uma homologação, muitas lojas), então o modelo certo é o
// DISTRIBUÍDO: as credenciais (Client ID/Secret) são do APP da
// integradora; cada LOJA autoriza o app no Portal do Parceiro com
// um código de vínculo (POST /oauth/userCode, vale 10 min) e devolve
// um código de autorização, que trocamos por access token +
// REFRESH TOKEN (grantType=authorization_code). O access token
// expira pelo expiresIn da resposta (referência: 21600s) e é
// renovado com grantType=refresh_token; refresh vale ~7 dias —
// expirado, a loja precisa autorizar de novo. Sem refresh token
// guardado, cai pro fluxo centralizado (client_credentials), que
// atende apps de uma loja só. Eventos: API de Eventos v1.0
// (GET /events/v1.0/events:polling + POST /events/acknowledgment),
// NUNCA sob /order — era o erro da v1.12.0.
const { get, all, run } = require('./db');
const { lojaId: lid } = require('./tenant');

async function preparar() {
  await run(`CREATE TABLE IF NOT EXISTS config_ifood (
    id INTEGER PRIMARY KEY, client_id TEXT, client_secret TEXT,
    merchant_id TEXT, ativo INTEGER NOT NULL DEFAULT 0,
    ultima_poll TEXT, total_importados INTEGER NOT NULL DEFAULT 0
  )`);
  for (const sql of [
    'ALTER TABLE config_ifood ADD COLUMN ultima_poll TEXT',
    'ALTER TABLE config_ifood ADD COLUMN total_importados INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE config_ifood ADD COLUMN refresh_token TEXT',
    'ALTER TABLE config_ifood ADD COLUMN user_code TEXT',
    'ALTER TABLE config_ifood ADD COLUMN code_verifier TEXT',
    'ALTER TABLE config_ifood ADD COLUMN user_code_expira TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_origem_externo ON pedidos (loja_id, origem, externo_id) WHERE externo_id IS NOT NULL',
  ]) { try { await run(sql); } catch { /* já existe */ } }
}

async function linha() {
  await run('INSERT OR IGNORE INTO config_ifood (id) VALUES (?)', lid());
  return get('SELECT * FROM config_ifood WHERE id=?', lid());
}

function mascarar(s) {
  const t = String(s || '');
  if (t.length <= 4) return '••••';
  return t.slice(0, 3) + '••••' + t.slice(-2);
}

async function cfgPublica() {
  const c = await linha();
  const configurado = !!(c.client_id && c.client_secret && c.merchant_id);
  return {
    ativo: !!c.ativo,
    client_id: c.client_id || '',
    merchant_id: c.merchant_id || '',
    client_secret_configurado: !!c.client_secret,
    client_secret_mascarado: c.client_secret ? mascarar(c.client_secret) : '',
    configurado,
    ultima_poll: c.ultima_poll || null,
    total_importados: Number(c.total_importados || 0),
    autorizado: !!c.refresh_token,
    vinculo: (c.user_code && c.user_code_expira && new Date(c.user_code_expira) > new Date())
      ? { codigo: c.user_code, url: 'https://portal.ifood.com.br/apps/code?c=' + c.user_code, expira_em: c.user_code_expira }
      : null,
  };
}

async function salvarCfg(dados = {}) {
  const atual = await linha();
  let secret = atual.client_secret || null;
  if (dados.limpar_secret) secret = null;
  else if (String(dados.client_secret || '').trim()) secret = String(dados.client_secret).trim();
  const clientId = String(dados.client_id !== undefined ? dados.client_id : (atual.client_id || '')).trim() || null;
  const merchantId = String(dados.merchant_id !== undefined ? dados.merchant_id : (atual.merchant_id || '')).trim() || null;
  const ativo = dados.ativo ? 1 : 0;
  if (ativo && !(clientId && secret && merchantId)) {
    throw new Error('Pra ativar o iFood, preencha o Client ID, o Client Secret e o Merchant ID — são os dados que a homologação do iFood libera.');
  }
  await run('UPDATE config_ifood SET client_id=?, client_secret=?, merchant_id=?, ativo=? WHERE id=?',
    clientId, secret, merchantId, ativo, lid());
  return cfgPublica();
}

// Uso interno (futura sincronização de pedidos): credenciais reais.
async function credenciais() {
  const c = await linha();
  return { client_id: c.client_id, client_secret: c.client_secret, merchant_id: c.merchant_id, ativo: !!c.ativo, refresh_token: c.refresh_token || null };
}


// =====================================================================
// MOTOR (v1.12.0) — o sistema PRONTO pra receber o iFood: autentica,
// busca os eventos a cada 30s (polling oficial), importa o pedido
// pro painel como pedido nativo (origem 'ifood', sem duplicar) e
// devolve as confirmações quando o painel muda o status.
// =====================================================================
const crypto = require('node:crypto');
const { tx } = require('./db');

const API_BASE = process.env.IFOOD_API_BASE || 'https://merchant-api.ifood.com.br';
const tokens = new Map(); // lojaId -> { token, expira }

// POST no endpoint de token (os 3 grant types oficiais passam por aqui).
async function postToken(params) {
  const resp = await fetch(API_BASE + '/authentication/v1.0/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  let j = null;
  try { j = await resp.json(); } catch { /* erro sem corpo */ }
  if (!resp.ok) {
    const msg = (j && j.error && j.error.message) || '';
    const e = new Error('O iFood recusou a autenticação (' + resp.status + ')' + (msg ? ': ' + msg : '') + '. Confira as credenciais do app.');
    e.status = resp.status;
    throw e;
  }
  return j;
}

function guardarAccess(lojaId, j) {
  // A validade vem do expiresIn da resposta — a documentação manda
  // NUNCA fixar um tempo (a referência fala 21600s, o guia fala 3h).
  tokens.set(lojaId, { token: j.accessToken, expira: Date.now() + Number(j.expiresIn || 3600) * 1000 });
  return j.accessToken;
}

async function obterToken(lojaId, cred, forcar = false) {
  const t = tokens.get(lojaId);
  if (!forcar && t && t.expira > Date.now() + 60000) return t.token;
  if (cred.refresh_token) {
    // Modelo distribuído: renova com o refresh token DESTA loja.
    let j;
    try {
      j = await postToken({ grantType: 'refresh_token', clientId: cred.client_id, clientSecret: cred.client_secret, refreshToken: cred.refresh_token });
    } catch (e) {
      // Refresh expirado/revogado (~7 dias): a loja precisa autorizar
      // de novo. Limpa o guardado pra tela mostrar o estado real.
      await run('UPDATE config_ifood SET refresh_token=NULL WHERE id=?', lojaId).catch(() => {});
      tokens.delete(lojaId);
      const err = new Error('A autorização desta loja no iFood expirou. Gere um novo código de vínculo na configuração do iFood e autorize de novo no Portal do Parceiro.');
      err.reautorizar = true;
      throw err;
    }
    const novoRefresh = j.refreshToken || j.refresh_token;
    if (novoRefresh && novoRefresh !== cred.refresh_token) {
      cred.refresh_token = novoRefresh;
      await run('UPDATE config_ifood SET refresh_token=? WHERE id=?', novoRefresh, lojaId).catch(() => {});
    }
    return guardarAccess(lojaId, j);
  }
  // Modelo centralizado (app de uma loja só): sem refresh — token
  // novo a cada expiração.
  const j = await postToken({ grantType: 'client_credentials', clientId: cred.client_id, clientSecret: cred.client_secret });
  return guardarAccess(lojaId, j);
}

// Passo 1 do vínculo (distribuído): gera o código que a loja digita
// no Portal do Parceiro. Vale 10 minutos (expiresIn da resposta).
async function gerarVinculo() {
  const cred = await credenciais();
  if (!cred.client_id) throw new Error('Salve o Client ID do app (integradora) antes de gerar o código de vínculo.');
  const resp = await fetch(API_BASE + '/authentication/v1.0/oauth/userCode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ clientId: cred.client_id }),
  });
  let j = null;
  try { j = await resp.json(); } catch { /* erro sem corpo */ }
  if (!resp.ok) {
    // 400 aqui quase sempre = app CENTRALIZADO (o app de teste é um):
    // o userCode só existe no modelo distribuído. Sem essa explicação
    // a pessoa sai procurando erro de digitação que não existe
    // (aconteceu com o Gabriel em 23/10).
    if (resp.status === 400) throw new Error('O iFood recusou o código de vínculo (400). Isso acontece quando o app é CENTRALIZADO (o app de teste é assim): app centralizado NÃO usa vínculo. É só ligar a integração lá em cima e clicar em "Verificar pedidos agora". O vínculo é só para app DISTRIBUÍDO.');
    throw new Error('O iFood não gerou o código de vínculo (' + resp.status + '). Confira o Client ID do app.');
  }
  if (!j || !j.userCode) throw new Error('O iFood respondeu sem o código de vínculo. Tente de novo.');
  const expira = new Date(Date.now() + Number(j.expiresIn || 600) * 1000);
  await run('UPDATE config_ifood SET user_code=?, code_verifier=?, user_code_expira=? WHERE id=?',
    j.userCode, j.authorizationCodeVerifier || null, expira.toISOString(), lid());
  return { codigo: j.userCode, url: j.verificationUrlComplete || ('https://portal.ifood.com.br/apps/code?c=' + j.userCode), expira_em: expira.toISOString() };
}

// Passo 2: a loja autorizou no Portal e devolveu o código de
// autorização (vale ~5 min) — troca por access + refresh token.
async function confirmarVinculo(codigoAutorizacao) {
  const c = await linha();
  if (!c.user_code || !c.code_verifier) throw new Error('Gere o código de vínculo primeiro — sem ele não há o que confirmar.');
  if (c.user_code_expira && new Date(c.user_code_expira) < new Date()) {
    throw new Error('O código de vínculo expirou (vale 10 minutos). Gere outro e autorize de novo.');
  }
  const code = String(codigoAutorizacao || '').trim();
  if (!code) throw new Error('Cole o código de autorização que o Portal do Parceiro mostrou pra loja.');
  const j = await postToken({
    grantType: 'authorization_code', clientId: c.client_id, clientSecret: c.client_secret,
    authorizationCode: code, authorizationCodeVerifier: c.code_verifier,
  });
  const refresh = j.refreshToken || j.refresh_token || null;
  if (!refresh) throw new Error('O iFood não devolveu o token de renovação. Confira se o app está cadastrado como DISTRIBUÍDO no Portal do Desenvolvedor e tente de novo.');
  await run('UPDATE config_ifood SET refresh_token=?, user_code=NULL, code_verifier=NULL, user_code_expira=NULL WHERE id=?', refresh, lid());
  guardarAccess(lid(), j);
  return cfgPublica();
}

async function apiIfood(lojaId, cred, metodo, caminho, corpo, headersExtra, tentativa = 0) {
  const token = await obterToken(lojaId, cred);
  const resp = await fetch(API_BASE + caminho, {
    method: metodo,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(headersExtra || {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  // A documentação manda: recebeu 401, peça um token novo e tente de
  // novo (o token pode ter sido revogado/expirado antes do previsto).
  if (resp.status === 401 && tentativa === 0) {
    tokens.delete(lojaId);
    return apiIfood(lojaId, cred, metodo, caminho, corpo, headersExtra, 1);
  }
  let json = null;
  try { json = await resp.json(); } catch { /* respostas 202/204 sem corpo */ }
  return { status: resp.status, json };
}

const cent = (v) => Math.round(Number(v || 0) * 100);

// Importa UM pedido do iFood como pedido nativo. Retorna true se
// criou (false se já existia — o polling pode repetir o evento).
async function importarPedido(det) {
  const lojaId = lid();
  const ja = await get("SELECT id FROM pedidos WHERE loja_id=? AND origem='ifood' AND externo_id=?", lojaId, String(det.id));
  if (ja) return false;

  const loja = await get(`SELECT proximo_numero FROM lojas WHERE id=${lid()}`);
  const numero = (loja && loja.proximo_numero) || 1;
  const tipo = det.orderType === 'TAKEOUT' ? 'retirada' : 'entrega';
  const cli = det.customer || {};
  const fone = String((cli.phone && cli.phone.number) || '').replace(/\D/g, '');
  const whats = fone || ('ifood' + String(det.id).slice(0, 8));
  const nome = String(cli.name || 'Cliente iFood').slice(0, 80);
  const da = det.deliveryAddress || {};
  const endereco = tipo === 'entrega' ? {
    rua: da.streetName || '', numero: da.streetNumber || '', complemento: da.complement || '',
    bairro: da.neighborhood || '', cidade: da.city || '', uf: da.state || '', cep: da.postalCode || '',
    referencia: da.reference || '', origem: 'ifood',
  } : null;
  const tot = det.total || {};
  const itensApi = Array.isArray(det.items) ? det.items : [];
  const subtotalCalc = itensApi.reduce((s2, it) => s2 + cent(it.totalPrice), 0);
  const subtotal = tot.subTotal !== undefined ? cent(tot.subTotal) : subtotalCalc;
  const taxa = tipo === 'entrega' ? cent(tot.deliveryFee) : 0;
  const total = tot.orderAmount !== undefined ? cent(tot.orderAmount) : subtotal + taxa;
  const pgto = (det.payments && Array.isArray(det.payments.methods) && det.payments.methods[0]) || {};
  const online = String(pgto.type || '').toUpperCase() === 'ONLINE';
  const metodo = online ? 'ifood_online' : (String(pgto.method || '').toUpperCase() === 'CASH' ? 'dinheiro' : 'cartao');
  const obs = ['Pedido do iFood' + (det.displayId ? ' #' + det.displayId : ''), det.extraInfo || ''].filter(Boolean).join(' — ');
  const token = crypto.randomBytes(12).toString('hex');
  const codigo = String(1000 + Math.floor(Math.random() * 9000));
  let pedidoId = null;

  await tx(async (q) => {
    const info = await q.run(`INSERT INTO pedidos (loja_id, numero, token, cliente_nome, cliente_whatsapp, tipo, bairro_id, bairro_nome,
      endereco_json, forma_pagamento, metodo_pagamento, troco_para_centavos, observacao, subtotal_centavos, taxa_entrega_centavos, total_centavos, codigo_entrega, origem, externo_id)
      VALUES (${lid()}, ?, ?, ?, ?, ?, NULL, ?, ?, 'ifood', ?, NULL, ?, ?, ?, ?, ?, 'ifood', ?)`,
      numero, token, nome, whats, tipo, endereco ? (endereco.bairro || null) : null,
      endereco ? JSON.stringify(endereco) : null, metodo, obs || null, subtotal, taxa, total, codigo, String(det.id));
    pedidoId = Number(info.lastInsertRowid);
    for (const it of itensApi) {
      const ii = await q.run('INSERT INTO pedido_itens (pedido_id, produto_id, nome_snapshot, preco_unitario_centavos, quantidade, subtotal_centavos, observacao) VALUES (?, NULL, ?, ?, ?, ?, ?)',
        pedidoId, String(it.name || 'Item do iFood').slice(0, 120), cent(it.unitPrice), Math.max(1, Number(it.quantity || 1)), cent(it.totalPrice), it.observations || null);
      for (const op of (it.options || [])) {
        const qtd = Math.max(1, Number(op.quantity || 1));
        await q.run('INSERT INTO pedido_item_opcoes (pedido_item_id, grupo_nome, opcao_nome, preco_adicional_centavos, excedente) VALUES (?, ?, ?, ?, 0)',
          Number(ii.lastInsertRowid), 'Adicionais', String(op.name || 'Adicional').slice(0, 80) + (qtd > 1 ? ' x' + qtd : ''), cent(op.unitPrice) * qtd);
      }
    }
    await q.run("INSERT INTO pagamentos (pedido_id, meio, provedor, valor_centavos, status, externo_id) VALUES (?, 'ifood', 'ifood', ?, ?, ?)",
      pedidoId, total, online ? 'pago' : 'pendente', String(det.id));
    await q.run("INSERT INTO pedido_status_historico (pedido_id, de_status, para_status, origem, autor) VALUES (?, NULL, 'NOVO', 'ifood', 'iFood')", pedidoId);
    await q.run(`UPDATE lojas SET proximo_numero = proximo_numero + 1 WHERE id=${lid()}`);
    await q.run(`INSERT INTO clientes (loja_id, nome, whatsapp, total_pedidos) VALUES (${lid()}, ?, ?, 1)
      ON CONFLICT(loja_id, whatsapp) DO UPDATE SET nome=excluded.nome, total_pedidos = clientes.total_pedidos + 1`, nome, whats);
    await q.run(`UPDATE pedidos SET cliente_id = (SELECT id FROM clientes WHERE loja_id=${lid()} AND whatsapp=?) WHERE id=?`, whats, pedidoId);
  });

  // Mesmos efeitos de um pedido do site: avisa o dono, push e tempo real.
  try {
    const pedidosCore = require('./pedidos');
    const notif = require('./notificacoes');
    const pushPainel = require('./push');
    const eventos = require('./eventos');
    const pedido = await pedidosCore.getPedido(pedidoId);
    const itens = await pedidosCore.getItensPedido(pedidoId);
    if (pedido) {
      await notif.notificarNovoPedido(pedido, itens);
      pushPainel.novoPedido(pedido);
      eventos.emitir('pedido', { acao: 'novo', pedido_id: pedidoId, numero });
    }
  } catch (e) { console.error('[ifood] efeitos do pedido importado:', e.message); }
  return true;
}

// Uma rodada de polling da loja do contexto: busca eventos, importa
// os pedidos novos (PLC) e confirma o recebimento dos eventos.
async function verificarAgora() {
  const cred = await credenciais();
  if (!cred.ativo || !cred.client_id || !cred.client_secret || !cred.merchant_id) {
    return { ok: false, motivo: 'Integração desligada ou faltando credencial (Client ID, Client Secret e Merchant ID).' };
  }
  const lojaId = lid();
  // API de EVENTOS v1.0 (base /events/v1.0) — a v1.12.0 chamava sob
  // /order e nunca receberia nada. 204 = nenhum evento pendente.
  const ev = await apiIfood(lojaId, cred, 'GET', '/events/v1.0/events:polling', null, { 'x-polling-merchants': cred.merchant_id });
  if (ev.status === 204) {
    await run("UPDATE config_ifood SET ultima_poll=datetime('now') WHERE id=?", lojaId);
    return { ok: true, eventos: 0, importados: 0 };
  }
  if (ev.status !== 200) throw new Error('O iFood respondeu ' + ev.status + ' ao buscar os eventos.');
  const eventos = Array.isArray(ev.json) ? ev.json : [];
  let importados = 0;
  const ids = [];
  for (const e of eventos) {
    if (e && e.id) ids.push(e.id);
    const codigo = String((e && (e.code || e.fullCode)) || '');
    if ((codigo === 'PLC' || codigo === 'PLACED') && e.orderId) {
      const det = await apiIfood(lojaId, cred, 'GET', '/order/v1.0/orders/' + e.orderId);
      if (det.status === 200 && det.json && det.json.id) {
        if (await importarPedido(det.json)) importados++;
      }
    }
  }
  if (ids.length) {
    await apiIfood(lojaId, cred, 'POST', '/events/v1.0/events/acknowledgment', ids.map((id) => ({ id }))).catch(() => {});
  }
  await run("UPDATE config_ifood SET ultima_poll=datetime('now'), total_importados = total_importados + ? WHERE id=?", importados, lojaId);
  return { ok: true, eventos: eventos.length, importados };
}

// Lojas com a integração pronta (o ciclo de 30s roda pra cada uma).
async function lojasAtivas() {
  return all("SELECT id FROM config_ifood WHERE ativo=1 AND client_id IS NOT NULL AND client_secret IS NOT NULL AND merchant_id IS NOT NULL");
}

// O painel mexeu no pedido → o iFood fica sabendo (melhor esforço:
// falha aqui nunca trava o painel, só registra no log).
async function aoMudarStatus(pedido, para) {
  try {
    if (!pedido || pedido.origem !== 'ifood' || !pedido.externo_id) return;
    const cred = await credenciais();
    if (!cred.ativo) return;
    const lojaId = lid();
    const base = '/order/v1.0/orders/' + pedido.externo_id;
    if (para === 'EM_PREPARO') await apiIfood(lojaId, cred, 'POST', base + '/confirm');
    else if (para === 'PRONTO' && pedido.tipo === 'retirada') await apiIfood(lojaId, cred, 'POST', base + '/readyToPickup');
    else if (para === 'SAIU_ENTREGA') await apiIfood(lojaId, cred, 'POST', base + '/dispatch');
    else if (para === 'CANCELADO') await apiIfood(lojaId, cred, 'POST', base + '/requestCancellation', { reason: 'Cancelado pela loja no painel de pedidos.' });
  } catch (e) { console.error('[ifood] aoMudarStatus:', e.message); }
}

module.exports = { preparar, cfgPublica, salvarCfg, credenciais, verificarAgora, lojasAtivas, aoMudarStatus, gerarVinculo, confirmarVinculo };
