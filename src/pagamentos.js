'use strict';

// Nome da loja nas descrições/mensagens de pagamento (v1.9.29).
let _nomeLojaCache = null;
let _nomeLojaCacheEm = 0;
async function nomeLoja() {
  // 1.16.44: o nome era cacheado pra sempre no processo — se o dono
  // renomeasse a loja, os pagamentos seguiam com o nome velho. TTL de 5 min.
  if (_nomeLojaCache && Date.now() - _nomeLojaCacheEm < 5 * 60 * 1000) return _nomeLojaCache;
  try { const l = await get('SELECT nome FROM lojas WHERE id=1'); if (l && l.nome) { _nomeLojaCache = l.nome; _nomeLojaCacheEm = Date.now(); } } catch { /* ignora */ }
  return _nomeLojaCache || 'a loja';
}
// Meios de Recebimento + pagamentos online (Mercado Pago / Asaas).
// Regra de ouro do contrato: erro de gateway NUNCA bloqueia a venda — o pedido
// nasce com pagamento.status = 'erro_config' e a loja cobra manualmente.
const { get, all, run } = require('./db');
const { mascarar, ehMascarado } = require('./util');
const notif = require('./notificacoes');
const eventos = require('./eventos');

const MEIOS = ['pix_presencial', 'cartao_presencial', 'dinheiro', 'mercadopago', 'asaas'];
const CAMPOS_CREDENCIAIS = {
  mercadopago: ['access_token', 'public_key', 'webhook_secret'],
  asaas: ['api_key', 'webhook_token'],
};

async function getConfig(meio) {
  const row = await get('SELECT * FROM config_recebimentos WHERE loja_id=1 AND meio=?', meio);
  if (!row) return null;
  return { ...row, credenciais: JSON.parse(row.credenciais_json || '{}'), extra: JSON.parse(row.extra_json || '{}') };
}
async function listarConfigMascarado() {
  const saida = [];
  for (const meio of MEIOS) {
    const c = await getConfig(meio);
    if (!c) { saida.push({ meio, ativo: false, ambiente: 'sandbox', credenciais: {}, extra: {} }); continue; }
    const credenciais = {};
    for (const k of Object.keys(c.credenciais)) credenciais[k] = mascarar(c.credenciais[k]);
    saida.push({ meio, ativo: !!c.ativo, ambiente: c.ambiente, credenciais, extra: c.extra });
  }
  return saida;
}
async function atualizarConfig(meio, corpo) {
  const atual = await getConfig(meio);
  if (!atual) throw new Error('Meio de recebimento desconhecido.');
  const credenciais = { ...atual.credenciais };
  if (corpo.credenciais && typeof corpo.credenciais === 'object') {
    for (const [k, v] of Object.entries(corpo.credenciais)) {
      if (v === '' || v == null || ehMascarado(v)) continue; // vazio/mascarado = mantém
      credenciais[k] = String(v);
    }
  }
  const extra = corpo.extra && typeof corpo.extra === 'object' ? { ...atual.extra, ...corpo.extra } : atual.extra;
  // 1.16.44: ambiente inválido não pode cair na URL de produção com chave
  // de sandbox — só aceita os dois valores conhecidos.
  const ambiente = (corpo.ambiente === 'sandbox' || corpo.ambiente === 'producao') ? corpo.ambiente : atual.ambiente;
  await run('UPDATE config_recebimentos SET ativo=?, ambiente=?, credenciais_json=?, extra_json=? WHERE loja_id=1 AND meio=?',
    corpo.ativo === undefined ? atual.ativo : (corpo.ativo ? 1 : 0),
    ambiente,
    JSON.stringify(credenciais), JSON.stringify(extra), meio);
  return (await listarConfigMascarado()).find(x => x.meio === meio);
}

// Métodos que o checkout pode mostrar: só ativos E configurados (online).
// 1.16.42: o cliente vê UM "Pix online" e UM "Cartão online" — NUNCA o nome
// do provedor (nada de "Asaas" ou "Mercado Pago" na tela dele). O provedor
// é resolvido no servidor (resolverOnline: Asaas primeiro, depois MP).
async function metodosPublicos(loja) {
  const metodos = [];
  const pix = await getConfig('pix_presencial');
  if (pix && pix.ativo) metodos.push({ codigo: 'pix', rotulo: 'Pix (na entrega)', online: false });
  const cartao = await getConfig('cartao_presencial');
  if (cartao && cartao.ativo) metodos.push({ codigo: 'cartao', rotulo: 'Cartão (na entrega)', online: false });
  const din = await getConfig('dinheiro');
  if (din && din.ativo) metodos.push({ codigo: 'dinheiro', rotulo: 'Dinheiro', online: false });
  const mp = await getConfig('mercadopago');
  const asaas = await getConfig('asaas');
  const pixOnline = (provedorPronto(asaas, 'api_key') && asaas.extra.pix_online !== false)
    || (provedorPronto(mp, 'access_token') && mp.extra.pix_online !== false);
  if (pixOnline) metodos.push({ codigo: 'pix_online', rotulo: 'Pix online', online: true });
  const cartaoOnline = (provedorPronto(asaas, 'api_key') && asaas.extra.cartao_online !== false)
    || (provedorPronto(mp, 'access_token') && mp.extra.cartao_online !== false);
  if (cartaoOnline) metodos.push({ codigo: 'cartao_online', rotulo: 'Cartão online', online: true });
  return metodos;
}
function provedorPronto(cfg, chaveCred) {
  return !!(cfg && cfg.ativo && cfg.credenciais && cfg.credenciais[chaveCred]);
}
// 1.16.42: resolve o provedor de um método online genérico.
// Prioridade: Asaas, depois Mercado Pago (o ADM desliga o que não usa).
// Devolve o código interno (pix_asaas, pix_mp...) ou null.
async function resolverOnline(metodoGenerico) {
  const tipo = metodoGenerico === 'pix_online' ? 'pix' : metodoGenerico === 'cartao_online' ? 'cartao' : null;
  if (!tipo) return null;
  const mp = await getConfig('mercadopago');
  const asaas = await getConfig('asaas');
  const chave = tipo === 'pix' ? 'pix_online' : 'cartao_online';
  if (provedorPronto(asaas, 'api_key') && asaas.extra[chave] !== false) return tipo === 'pix' ? 'pix_asaas' : 'cartao_asaas';
  if (provedorPronto(mp, 'access_token') && mp.extra[chave] !== false) return tipo === 'pix' ? 'pix_mp' : 'cartao_mp';
  return null;
}
// Códigos antigos (pix_asaas, pix_mp...) viram o genérico — páginas em cache
// continuam funcionando depois da publicação.
function normalizarMetodo(metodo) {
  if (metodo === 'pix_asaas' || metodo === 'pix_mp') return 'pix_online';
  if (metodo === 'cartao_asaas' || metodo === 'cartao_mp') return 'cartao_online';
  return metodo;
}
const ehOnline = (metodo) => ['pix_mp', 'cartao_mp', 'pix_asaas', 'cartao_asaas', 'pix_online', 'cartao_online'].includes(metodo);

// 1.16.44: valor em reais com 2 casas EXATAS — `total/100` em float pode
// gerar 19.989999...; toFixed(2) devolve a string decimal certa.
function valorReais(centavos) { return Number((Number(centavos || 0) / 100).toFixed(2)); }
// 1.16.44: base pública do site (pra volta do Mercado Pago) — vem do
// request; localhost/IP não serve (o MP rejeita domínio local).
function baseUrlPublica(req) {
  if (!req) return null;
  const proto = (req.headers && req.headers['x-forwarded-proto']) || req.protocol || 'https';
  const host = (req.headers && req.headers['x-forwarded-host']) || (req.get && req.get('host')) || '';
  if (!host || /localhost|127\.0\.0\.1|^\d+\.\d+\.\d+\.\d+/.test(host)) return null;
  return proto + '://' + host;
}
// 1.16.44: quando o pagamento confirma com outro método (ex.: o cliente
// escolheu cartão no MP e pagou via Pix), corrige o registro pra verdade:
// o rótulo, o recibo e o Financeiro passam a mostrar o método real.
async function corrigirMetodoReal(pagamento, tipoReal) {
  if (!pagamento || (tipoReal !== 'pix' && tipoReal !== 'cartao')) return;
  const provedor = pagamento.provedor === 'mercadopago' ? 'mp' : 'asaas';
  const meioCerto = tipoReal === 'pix' ? 'pix_' + provedor : 'cartao_' + provedor;
  if (pagamento.meio === meioCerto) return;
  await run('UPDATE pagamentos SET meio=? WHERE id=?', meioCerto, pagamento.id);
  const generico = tipoReal === 'pix' ? 'pix_online' : 'cartao_online';
  const forma = tipoReal === 'pix' ? 'pix' : 'cartao';
  await run('UPDATE pedidos SET metodo_pagamento=?, forma_pagamento=? WHERE id=?', generico, forma, pagamento.pedido_id);
}
// ---------------- Adaptadores ----------------
async function mpCriarPagamento(pedido, metodo, baseUrl) {
  const cfg = await getConfig('mercadopago');
  if (!cfg || !cfg.credenciais.access_token) throw new Error('Mercado Pago sem access_token.');
  const token = cfg.credenciais.access_token;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Idempotency-Key': `pedido-${pedido.id}` };
  const loja = await get('SELECT * FROM lojas WHERE id=1');
  if (metodo === 'pix_mp') {
    const resp = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST', headers, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        transaction_amount: valorReais(pedido.total_centavos),
        description: `Pedido #${pedido.numero} — ${await nomeLoja()}`,
        payment_method_id: 'pix',
        external_reference: String(pedido.id),
        // MP exige payer.email; sem cadastro de e-mail do cliente usamos o da loja (limitação registrada no contrato)
        payer: { email: (loja && loja.email_pedidos) || 'pedidos@acaidoguri.local', first_name: pedido.cliente_nome },
      }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error('MP Pix HTTP ' + resp.status + ': ' + JSON.stringify(json).slice(0, 200));
    const td = json.point_of_interaction && json.point_of_interaction.transaction_data;
    return { externo_id: String(json.id), qr_texto: td ? td.qr_code : null, link_pagamento: td ? td.ticket_url : null, expira_em: json.date_of_expiration || null };
  }
  // cartão: link via Checkout Pro (preference)
  // 1.16.44: a preference TRAVA o método — só cartão de crédito e débito
  // (boleto, Pix e outros somem da página do MP); volta automática pra
  // tela do pedido quando aprova; aviso vai direto pro nosso webhook.
  const corpoPref = {
    items: [{ title: `Pedido #${pedido.numero} — ${await nomeLoja()}`, quantity: 1, unit_price: valorReais(pedido.total_centavos), currency_id: 'BRL' }],
    external_reference: String(pedido.id),
    payment_methods: {
      excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }, { id: 'bank_transfer' }, { id: 'digital_currency' }, { id: 'digital_wallet' }, { id: 'prepaid_card' }],
      installments: 12,
    },
  };
  if (baseUrl) {
    const volta = baseUrl + '/pedido/' + pedido.token;
    corpoPref.back_urls = { success: volta, failure: volta, pending: volta };
    corpoPref.auto_return = 'approved';
    corpoPref.notification_url = baseUrl + '/api/webhooks/mercadopago';
  }
  const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST', headers, signal: AbortSignal.timeout(15000),
    body: JSON.stringify(corpoPref),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('MP Preference HTTP ' + resp.status + ': ' + JSON.stringify(json).slice(0, 200));
  const link = cfg.ambiente === 'sandbox' ? (json.sandbox_init_point || json.init_point) : json.init_point;
  return { externo_id: String(json.id), qr_texto: null, link_pagamento: link, expira_em: null };
}

function asaasBase(cfg) { return cfg.ambiente === 'sandbox' ? 'https://sandbox.asaas.com/api/v3' : 'https://api.asaas.com/v3'; }
async function asaasFetch(cfg, metodoHttp, caminho, corpo) {
  const resp = await fetch(asaasBase(cfg) + caminho, {
    method: metodoHttp, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', access_token: cfg.credenciais.api_key },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Asaas ${caminho} HTTP ` + resp.status + ': ' + JSON.stringify(json).slice(0, 200));
  return json;
}
async function asaasCriarPagamento(pedido, metodo) {
  const cfg = await getConfig('asaas');
  if (!cfg || !cfg.credenciais.api_key) throw new Error('Asaas sem api_key.');
  const fone = String(pedido.cliente_whatsapp || '').replace(/\D/g, '');
  // 1.16.44: reaproveita o cliente pelo telefone — antes criava um cliente
  // novo no Asaas a cada pedido do mesmo número.
  let clienteId = null;
  if (fone) {
    try {
      const busca = await asaasFetch(cfg, 'GET', '/customers?mobilePhone=' + encodeURIComponent(fone));
      const achado = busca && Array.isArray(busca.data) && busca.data[0];
      if (achado && achado.id) clienteId = achado.id;
    } catch { /* busca falhou — cria um novo, como antes */ }
  }
  if (!clienteId) {
    const cliente = await asaasFetch(cfg, 'POST', '/customers', { name: pedido.cliente_nome, mobilePhone: fone });
    clienteId = cliente.id;
  }
  const vencimento = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  // 1.16.43: cartão vai como CREDIT_CARD — o cliente digita os dados na
  // página segura do Asaas (link "Pagar agora"). NENHUM dado de cartão
  // passa pela loja/servidor. O dinheiro do Pix E do cartão cai na conta
  // Asaas da loja (a transferência pro banco é dentro do Asaas).
  // (Doc oficial Asaas: criar a cobrança sem os dados do cartão e
  // direcionar o cliente pra invoiceUrl — débito com função crédito
  // funciona porque o Asaas cobra como crédito.)
  const cobranca = await asaasFetch(cfg, 'POST', '/payments', {
    customer: clienteId,
    billingType: metodo === 'pix_asaas' ? 'PIX' : 'CREDIT_CARD',
    value: valorReais(pedido.total_centavos),
    dueDate: vencimento,
    description: `Pedido #${pedido.numero} — ${await nomeLoja()}`,
    externalReference: String(pedido.id),
  });
  let qr = null;
  if (metodo === 'pix_asaas') {
    try { const q = await asaasFetch(cfg, 'GET', `/payments/${cobranca.id}/pixQrCode`); qr = q.payload || null; } catch { /* QR opcional */ }
  }
  return { externo_id: String(cobranca.id), qr_texto: qr, link_pagamento: cobranca.invoiceUrl || null, expira_em: vencimento };
}

// Cria o registro de pagamento do pedido e, se online, chama o provedor.
// 1.16.42: recebe o código genérico (pix_online) e resolve o provedor aqui;
// o `meio` gravado é o interno (pix_asaas), para o webhook e os relatórios.
// 1.16.44: resolve o provedor ALTERNATIVO do mesmo método (o outro, que
// não é o `exceto`) — é o plano B do failover.
async function resolverOnlineAlternativo(metodoGenerico, excetoInterno) {
  const tipo = metodoGenerico === 'pix_online' ? 'pix' : metodoGenerico === 'cartao_online' ? 'cartao' : null;
  if (!tipo) return null;
  const mp = await getConfig('mercadopago');
  const asaas = await getConfig('asaas');
  const chave = tipo === 'pix' ? 'pix_online' : 'cartao_online';
  const candAsaas = tipo === 'pix' ? 'pix_asaas' : 'cartao_asaas';
  const candMp = tipo === 'pix' ? 'pix_mp' : 'cartao_mp';
  if (candAsaas !== excetoInterno && provedorPronto(asaas, 'api_key') && asaas.extra[chave] !== false) return candAsaas;
  if (candMp !== excetoInterno && provedorPronto(mp, 'access_token') && mp.extra[chave] !== false) return candMp;
  return null;
}
async function iniciarPagamento(pedido, metodo, opts) {
  metodo = normalizarMetodo(metodo);
  if (!ehOnline(metodo)) {
    await run('INSERT INTO pagamentos (pedido_id, meio, provedor, valor_centavos, status) VALUES (?, ?, ?, ?, ?)',
      pedido.id, metodo, 'interno', pedido.total_centavos, 'nao_aplicavel');
    return { status: 'nao_aplicavel' };
  }
  const interno = await resolverOnline(metodo);
  if (!interno) {
    // Provedor desligado entre o checkout e a criação: registra e deixa a
    // loja cobrar manualmente — a venda nunca trava por causa do gateway.
    await run('INSERT INTO pagamentos (pedido_id, meio, provedor, valor_centavos, status) VALUES (?, ?, ?, ?, ?)',
      pedido.id, metodo, 'interno', pedido.total_centavos, 'erro_config');
    await run('UPDATE pedidos SET pagamento_status=? WHERE id=?', 'erro_config', pedido.id);
    return { status: 'erro_config' };
  }
  const provedor = interno.endsWith('_mp') ? 'mercadopago' : 'asaas';
  const info = await run('INSERT INTO pagamentos (pedido_id, meio, provedor, valor_centavos, status) VALUES (?, ?, ?, ?, ?)',
    pedido.id, interno, provedor, pedido.total_centavos, 'pendente');
  const pagamentoId = Number(info.lastInsertRowid);
  const baseUrl = (opts && opts.baseUrl) || null;
  let r = null;
  let meioUsado = interno;
  let provedorUsado = provedor;
  try {
    r = provedor === 'mercadopago' ? await mpCriarPagamento(pedido, interno, baseUrl) : await asaasCriarPagamento(pedido, interno);
  } catch (e) {
    // 1.16.44 FAILOVER: o provedor principal falhou (chave inválida, fora
    // do ar, timeout) — tenta o OUTRO provedor antes de desistir. Só vira
    // erro_config se os dois falharem. (Se a cobrança já tinha sido criada
    // no primeiro e a resposta se perdeu, ela expira sozinha em 24h.)
    const alt = await resolverOnlineAlternativo(metodo, interno);
    if (!alt) {
      // Sem plano B: vira erro_config aqui mesmo (nunca deixa o pedido
      // como "nao_aplicavel" nem a cobrança como "pendente" sem link).
      await run('UPDATE pagamentos SET status=?, ultimo_evento=?, atualizado_em=datetime(\'now\') WHERE id=?',
        'erro_config', JSON.stringify({ erro: String(e.message || e).slice(0, 300) }), pagamentoId);
      await run('UPDATE pedidos SET pagamento_status=? WHERE id=?', 'erro_config', pedido.id);
      await notif.notificarDonoTexto(`ATENÇÃO: Pedido #${pedido.numero}: falha ao gerar pagamento online (${provedor}). Cobre manualmente na entrega.`, pedido.id);
      return { status: 'erro_config' };
    }
    let provAlt = alt.endsWith('_mp') ? 'mercadopago' : 'asaas';
    try {
      r = provAlt === 'mercadopago' ? await mpCriarPagamento(pedido, alt, baseUrl) : await asaasCriarPagamento(pedido, alt);
      meioUsado = alt;
      provedorUsado = provAlt;
    } catch (e2) {
      await run('UPDATE pagamentos SET status=?, ultimo_evento=?, atualizado_em=datetime(\'now\') WHERE id=?',
        'erro_config', JSON.stringify({ erro: String(e.message || e).slice(0, 150) + ' | failover: ' + String(e2.message || e2).slice(0, 150) }), pagamentoId);
      await run('UPDATE pedidos SET pagamento_status=? WHERE id=?', 'erro_config', pedido.id);
      await notif.notificarDonoTexto(`ATENÇÃO: Pedido #${pedido.numero}: falha ao gerar pagamento online (${provedor} e ${provAlt}). Cobre manualmente na entrega.`, pedido.id);
      return { status: 'erro_config' };
    }
  }
  try {
    await run('UPDATE pagamentos SET meio=?, provedor=?, externo_id=?, qr_texto=?, link_pagamento=?, expira_em=?, atualizado_em=datetime(\'now\') WHERE id=?',
      meioUsado, provedorUsado, r.externo_id, r.qr_texto, r.link_pagamento, r.expira_em || null, pagamentoId);
    /* 1.16.43: o pedido passa a "aguardando pagamento" — antes ficava
       "nao_aplicavel" e a caixa de pagamento (QR/link) NUNCA aparecia pro
       cliente, nem o selo "aguardando pagamento" no painel, até o webhook
       virar "pago". */
    await run('UPDATE pedidos SET pagamento_status=? WHERE id=?', 'pendente', pedido.id);
    return { status: 'pendente', qr_texto: r.qr_texto, link_pagamento: r.link_pagamento, expira_em: r.expira_em || null };
  } catch (e) {
    await run('UPDATE pagamentos SET status=?, ultimo_evento=?, atualizado_em=datetime(\'now\') WHERE id=?',
      'erro_config', JSON.stringify({ erro: String(e.message || e).slice(0, 300) }), pagamentoId);
    await run('UPDATE pedidos SET pagamento_status=? WHERE id=?', 'erro_config', pedido.id);
    await notif.notificarDonoTexto(`ATENÇÃO: Pedido #${pedido.numero}: falha ao gerar pagamento online (${provedorUsado}). Cobre manualmente na entrega.`, pedido.id);
    return { status: 'erro_config' };
  }
}
// 1.16.44: gerar o pagamento de novo — pra tela do cliente (botão "Tentar
// pagar online novamente") e pro painel. Só vale quando o pagamento está
// com erro ou falhou; se já existe um pendente (retry clicado 2x), devolve
// ele em vez de criar outra cobrança.
async function tentarPagamentoNovamente(pedido, opts) {
  const pendente = await get('SELECT * FROM pagamentos WHERE pedido_id=? AND status=? ORDER BY id DESC LIMIT 1', pedido.id, 'pendente');
  if (pendente) return { status: 'pendente', qr_texto: pendente.qr_texto || null, link_pagamento: pendente.link_pagamento || null, expira_em: pendente.expira_em || null };
  const metodo = normalizarMetodo(pedido.metodo_pagamento || pedido.forma_pagamento || '');
  if (!ehOnline(metodo)) return { status: 'erro_config' };
  return iniciarPagamento(pedido, metodo, opts);
}

// Atualização vinda de webhook — idempotente: mesmo status não repete efeito.
async function aplicarStatusPagamento(pagamento, novoStatus, eventoResumo) {
  if (!pagamento) return;
  const anterior = pagamento.status;
  await run('UPDATE pagamentos SET status=?, ultimo_evento=?, atualizado_em=datetime(\'now\') WHERE id=?',
    novoStatus, JSON.stringify(eventoResumo || {}).slice(0, 2000), pagamento.id);
  await run('UPDATE pedidos SET pagamento_status=?, updated_at=datetime(\'now\') WHERE id=?', novoStatus, pagamento.pedido_id);
  if (anterior === novoStatus) return; // idempotência
  const pedido = await get('SELECT * FROM pedidos WHERE id=?', pagamento.pedido_id);
  if (!pedido) return;
  if (novoStatus === 'pago') {
    await notif.notificarDonoTexto(`Pagamento do pedido #${pedido.numero} confirmado (${pagamento.provedor}).`, pedido.id);
    await notif.enfileirar({ canal: 'whatsapp_cliente', destino: pedido.cliente_whatsapp, corpo: `Pagamento do pedido *#${pedido.numero}* confirmado! Obrigado. — ${await nomeLoja()}`, pedidoId: pedido.id });
  }
  eventos.emitir('pedido', { acao: 'pagamento', pedido_id: pedido.id, numero: pedido.numero, pagamento_status: novoStatus });
}

// ---------------- Webhooks ----------------
// 1.16.43: busca o pagamento preferindo o pedido_id (external_reference,
// nosso id, único) e só cai pro externo_id se ele não vier — o OR numa
// única busca podia casar o pagamento errado se o id externo repetisse.
async function buscarPagamento(provedor, externoId, pedidoId) {
  const ref = Number(pedidoId) || -1;
  if (ref > 0) {
    const porPedido = await get('SELECT * FROM pagamentos WHERE provedor=? AND pedido_id=?', provedor, ref);
    if (porPedido) return porPedido;
  }
  if (externoId) return await get('SELECT * FROM pagamentos WHERE provedor=? AND externo_id=?', provedor, String(externoId));
  return null;
}
async function webhookMercadoPago(corpo) {
  const cfg = await getConfig('mercadopago');
  const idPagamentoMp = (corpo && corpo.data && corpo.data.id) || (corpo && corpo.id);
  if (!idPagamentoMp || !cfg || !cfg.credenciais.access_token) return { processado: false };
  const resp = await fetch(`https://api.mercadopago.com/v1/payments/${idPagamentoMp}`, {
    headers: { Authorization: `Bearer ${cfg.credenciais.access_token}` }, signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) return { processado: false };
  const json = await resp.json().catch(() => ({}));
  const pag = await buscarPagamento('mercadopago', json.id, json.external_reference);
  if (!pag) return { processado: false };
  const mapa = { approved: 'pago', rejected: 'falhou', cancelled: 'falhou', refunded: 'estornado', charged_back: 'estornado', pending: 'pendente', in_process: 'pendente', authorized: 'pendente' };
  const novo = mapa[json.status];
  // 1.16.44: o método REAL (o que o cliente de fato usou no MP) vence o
  // escolhido — quem escolheu cartão e pagou via Pix fica como Pix online.
  if (novo) {
    const tipoReal = json.payment_method_id === 'pix' ? 'pix' : (json.payment_type_id === 'credit_card' || json.payment_type_id === 'debit_card') ? 'cartao' : null;
    if (tipoReal) await corrigirMetodoReal(pag, tipoReal);
  }
  if (novo) await aplicarStatusPagamento(pag, novo, { provedor: 'mercadopago', status_mp: json.status, id: json.id });
  return { processado: true };
}
async function webhookAsaas(corpo, headers) {
  const cfg = await getConfig('asaas');
  const tokenEsperado = cfg && cfg.credenciais.webhook_token;
  // Fail-closed (v1.9.28): sem o token cadastrado no painel, o aviso é
  // ignorado — aceitar POST de qualquer um marcaria pedido como pago.
  if (!tokenEsperado) { console.warn('[webhook asaas] webhook_token não configurado no painel — aviso ignorado.'); return { processado: false, erro: 'webhook_token não configurado' }; }
  if (headers['asaas-access-token'] !== tokenEsperado) return { processado: false, erro: 'token inválido' };
  const evento = corpo && corpo.event;
  const pay = (corpo && corpo.payment) || {};
  const pag = await buscarPagamento('asaas', pay.id, pay.externalReference);
  if (!pag) return { processado: false };
  const mapa = { PAYMENT_RECEIVED: 'pago', PAYMENT_CONFIRMED: 'pago', PAYMENT_OVERDUE: 'falhou', PAYMENT_DELETED: 'falhou', PAYMENT_REFUNDED: 'estornado' };
  let novo = mapa[evento];
  // 1.16.44: reconfere a cobrança no Asaas antes de acreditar no aviso —
  // o token sozinho não basta: um aviso forjado (ou desatualizado) não
  // pode marcar um pedido como pago se a cobrança de verdade não está
  // paga. Se a consulta falhar, confia no aviso (o Asaas reenvia o
  // webhook depois) e registra o aviso.
  let tipoReal = null;
  if (pay.id) {
    try {
      const real = await asaasFetch(cfg, 'GET', `/payments/${pay.id}`);
      const mapaReal = { RECEIVED: 'pago', CONFIRMED: 'pago', OVERDUE: 'falhou', REFUNDED: 'estornado', CHARGEBACK_REQUESTED: 'estornado', CHARGEBACK_DISPUTE: 'estornado', AWAITING_CHARGEBACK_REVERSAL: 'estornado', DUNNING_REQUESTED: 'pendente', DUNNING_RECEIVED: 'pago', AWAITING_RISK_ANALYSIS: 'pendente', PENDING: 'pendente', AUTHORIZED: 'pendente' };
      if (real && real.status && mapaReal[real.status]) novo = mapaReal[real.status];
      if (real && real.billingType) tipoReal = real.billingType === 'PIX' ? 'pix' : real.billingType === 'CREDIT_CARD' ? 'cartao' : null;
    } catch (e) { console.warn('[webhook asaas] não consegui reconferir a cobrança ' + pay.id + ' — confiando no aviso. ' + String(e.message || e).slice(0, 120)); }
  }
  if (tipoReal) await corrigirMetodoReal(pag, tipoReal);
  if (novo) await aplicarStatusPagamento(pag, novo, { provedor: 'asaas', evento, id: pay.id });
  else await run('UPDATE pagamentos SET ultimo_evento=? WHERE id=?', JSON.stringify({ provedor: 'asaas', evento }).slice(0, 2000), pag.id);
  return { processado: true };
}

// ---------------- Teste de conexão ----------------
async function testarConexao(meio) {
  const cfg = await getConfig(meio);
  if (!cfg) return { ok: false, erro: 'Meio não encontrado.' };
  try {
    if (meio === 'mercadopago') {
      if (!cfg.credenciais.access_token) return { ok: false, erro: 'Access token não configurado.' };
      const resp = await fetch('https://api.mercadopago.com/users/me', { headers: { Authorization: `Bearer ${cfg.credenciais.access_token}` }, signal: AbortSignal.timeout(12000) });
      if (!resp.ok) return { ok: false, erro: 'Mercado Pago respondeu HTTP ' + resp.status };
      const json = await resp.json().catch(() => ({}));
      return { ok: true, detalhe: 'Conta conectada: ' + (json.nickname || json.email || json.id || 'ok') };
    }
    if (meio === 'asaas') {
      if (!cfg.credenciais.api_key) return { ok: false, erro: 'API key não configurada.' };
      const resp = await fetch(asaasBase(cfg) + '/myAccount', { headers: { access_token: cfg.credenciais.api_key }, signal: AbortSignal.timeout(12000) });
      if (!resp.ok) return { ok: false, erro: 'Asaas respondeu HTTP ' + resp.status };
      const json = await resp.json().catch(() => ({}));
      return { ok: true, detalhe: 'Conta conectada: ' + (json.name || json.email || json.id || 'ok') };
    }
    return { ok: true, detalhe: 'Meio presencial — nada para testar.' };
  } catch (e) {
    return { ok: false, erro: String(e.message || e).slice(0, 200) };
  }
}

module.exports = { MEIOS, CAMPOS_CREDENCIAIS, getConfig, listarConfigMascarado, atualizarConfig, metodosPublicos, resolverOnline, normalizarMetodo, ehOnline, iniciarPagamento, tentarPagamentoNovamente, baseUrlPublica, webhookMercadoPago, webhookAsaas, testarConexao };
