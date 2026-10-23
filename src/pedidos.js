'use strict';
// Núcleo de pedidos: cardápio, cálculo no servidor, criação e máquina de estados.
const { get, all, run, tx, execSql, modoBanco } = require('./db');
const { tokenAleatorio, normalizaFone, lojaEstaAberta } = require('./util');
const notif = require('./notificacoes');
const eventos = require('./eventos');
const fidelidade = require('./fidelidade');
const pushPainel = require('./push');

const TRANSICOES = {
  NOVO: ['EM_PREPARO', 'CANCELADO'],
  EM_PREPARO: ['PRONTO', 'CANCELADO'],
  PRONTO: ['SAIU_ENTREGA', 'ENTREGUE'],
  SAIU_ENTREGA: ['ENTREGUE'],
  ENTREGUE: [], CANCELADO: [],
};

async function getLoja() { return get('SELECT * FROM lojas WHERE id=1'); }

// Código de entrega (v1.9): 4 dígitos ('0000'–'9999') gerados na criação do
// pedido. É o PIN que o cliente informa ao entregador — e o mesmo PIN vai
// pra API da 99 quando a entrega é despachada por lá. Precisa ser único
// entre os pedidos NÃO finalizados (os que ainda podem ser entregues).
async function gerarCodigoEntrega() {
  for (let tent = 0; tent < 30; tent++) {
    const codigo = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const colide = await get("SELECT id FROM pedidos WHERE loja_id=1 AND codigo_entrega=? AND status NOT IN ('ENTREGUE','CANCELADO') LIMIT 1", codigo);
    if (!colide) return codigo;
  }
  // Colisão persistente (muito improvável): aceita repetir — o painel pede o
  // código sempre vinculado ao pedido específico, então o risco é mínimo.
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

async function montarCardapio() {
  const categorias = await all('SELECT id, nome, ordem FROM categorias WHERE loja_id=1 AND ativa=1 ORDER BY ordem, id');
  const produtos = await all('SELECT * FROM produtos WHERE loja_id=1 AND ativo=1 ORDER BY ordem, id');
  const gruposPorProduto = {};
  const rows = await all(`
    SELECT pg.produto_id, g.* FROM produto_grupos pg JOIN grupos_opcoes g ON g.id = pg.grupo_id
    WHERE g.ativo=1 ORDER BY pg.ordem, g.ordem, g.id`);
  for (const g of rows) {
    const opcoes = await all('SELECT id, nome, preco_adicional_centavos, esgotada, ordem FROM opcoes WHERE grupo_id=? AND ativa=1 ORDER BY ordem, id', g.id);
    (gruposPorProduto[g.produto_id] = gruposPorProduto[g.produto_id] || []).push({
      id: g.id, nome: g.nome, tipo_escolha: g.tipo_escolha, minimo: g.minimo, maximo: g.maximo,
      obrigatorio: !!g.obrigatorio, excedente_vira_pago: !!g.excedente_vira_pago,
      preco_excedente_centavos: g.preco_excedente_centavos, ordem: g.ordem, opcoes,
    });
  }
  return {
    categorias,
    produtos: produtos.map(p => ({
      id: p.id, categoria_id: p.categoria_id, nome: p.nome, descricao: p.descricao, foto_url: p.foto_url,
      preco_base_centavos: p.preco_base_centavos, tipo: p.tipo, destaque: !!p.destaque,
      esgotado: !!p.esgotado, ordem: p.ordem, grupos: gruposPorProduto[p.id] || [],
    })),
  };
}

// Valida e precifica UM item. Retorna {unit, opcoesSnapshot:[{grupo_nome, opcao_nome, preco, excedente}]} ou lança Error pt-BR.
async function precificarItem(item) {
  const produto = await get('SELECT * FROM produtos WHERE id=? AND loja_id=1', item.produto_id);
  if (!produto || !produto.ativo) throw new Error('Produto indisponível.');
  if (produto.esgotado) throw new Error(`"${produto.nome}" está esgotado no momento.`);
  const quantidade = Math.max(1, parseInt(item.quantidade || 1, 10));
  const selecionadas = Array.isArray(item.opcoes) ? [...new Set(item.opcoes.map(Number))] : [];

  // grupos vinculados ao produto
  const grupos = await all(`
    SELECT g.* FROM produto_grupos pg JOIN grupos_opcoes g ON g.id=pg.grupo_id
    WHERE pg.produto_id=? AND g.ativo=1 ORDER BY pg.ordem, g.ordem`, produto.id);
  const grupoIds = new Set(grupos.map(g => g.id));
  const opcoesDb = selecionadas.length
    ? await all(`SELECT o.*, o.grupo_id FROM opcoes o WHERE o.id IN (${selecionadas.map(() => '?').join(',')})`, ...selecionadas)
    : [];
  if (opcoesDb.length !== selecionadas.length) throw new Error('Uma das opções escolhidas não existe mais. Atualize o cardápio e tente de novo.');
  for (const o of opcoesDb) {
    if (!grupoIds.has(o.grupo_id)) throw new Error(`A opção "${o.nome}" não pertence a "${produto.nome}".`);
    if (!o.ativa) throw new Error(`A opção "${o.nome}" não está mais disponível.`);
    if (o.esgotada) throw new Error(`A opção "${o.nome}" está esgotada no momento.`);
  }

  let unit = produto.preco_base_centavos;
  const snapshot = [];
  for (const g of grupos) {
    const doGrupo = opcoesDb.filter(o => o.grupo_id === g.id);
    const minExigido = g.obrigatorio ? Math.max(g.minimo || 0, 1) : (g.minimo || 0);
    if (g.tipo_escolha === 'unica') {
      if (doGrupo.length > 1) throw new Error(`No grupo "${g.nome}" escolha apenas 1 opção.`);
      if (doGrupo.length < minExigido) throw new Error(`Escolha uma opção em "${g.nome}".`);
      for (const o of doGrupo) { unit += o.preco_adicional_centavos; snapshot.push({ grupo_nome: g.nome, opcao_nome: o.nome, preco: o.preco_adicional_centavos, excedente: 0 }); }
    } else { // multipla
      if (doGrupo.length < minExigido) throw new Error(`Escolha pelo menos ${minExigido} em "${g.nome}".`);
      if (g.maximo != null && doGrupo.length > g.maximo && !g.excedente_vira_pago) {
        throw new Error(`Em "${g.nome}" você pode escolher no máximo ${g.maximo}.`);
      }
      doGrupo.forEach((o, idx) => {
        let preco = o.preco_adicional_centavos, excedente = 0;
        if (g.maximo != null && idx >= g.maximo && g.excedente_vira_pago) { preco += g.preco_excedente_centavos; excedente = 1; }
        unit += preco;
        snapshot.push({ grupo_nome: g.nome, opcao_nome: o.nome, preco, excedente });
      });
    }
  }
  // grupos obrigatórios do produto que não vieram vinculados são ignorados; grupos não vinculados já tratados acima.
  return { produto, quantidade, unit, subtotal: unit * quantidade, snapshot };
}

async function criarPedido(corpo) {
  const loja = await getLoja();
  const estado = lojaEstaAberta(loja);
  if (!estado.aberta) throw new Error(estado.mensagem || 'Loja fechada no momento.');
  if (!corpo || !Array.isArray(corpo.itens) || corpo.itens.length === 0) throw new Error('O pedido está vazio.');
  const nome = String(corpo.cliente_nome || '').trim();
  const whats = normalizaFone(corpo.cliente_whatsapp);
  if (!nome) throw new Error('Informe seu nome.');
  if (whats.length < 12) throw new Error('Informe um WhatsApp válido com DDD.');
  const tipo = corpo.tipo === 'retirada' ? 'retirada' : 'entrega';

  // anti-trote básico: número bloqueado e limite de pedidos NOVO simultâneos
  const clienteExistente = await get('SELECT * FROM clientes WHERE loja_id=1 AND whatsapp=?', whats);
  if (clienteExistente && clienteExistente.bloqueado) throw new Error('Este número não pode fazer pedidos no momento. Fale com a loja pelo WhatsApp.');
  const novosSimultaneos = (await get("SELECT COUNT(*) c FROM pedidos WHERE loja_id=1 AND cliente_whatsapp=? AND status='NOVO'", whats)).c;
  if (novosSimultaneos >= 2) throw new Error('Você já tem pedidos aguardando confirmação. Aguarde a loja confirmar.');

  // taxa de entrega
  let taxa = 0, bairroNome = null;
  if (tipo === 'entrega') {
    if (corpo.bairro_id) {
      const b = await get('SELECT * FROM bairros WHERE id=? AND loja_id=1 AND ativo=1', corpo.bairro_id);
      if (!b) throw new Error('Bairro não atendido. Escolha um bairro da lista.');
      taxa = b.taxa_centavos; bairroNome = b.bairro;
    } else if (loja.taxa_unica_centavos != null) {
      taxa = loja.taxa_unica_centavos;
    } else {
      // Sem taxa única: se a loja TEM bairros cadastrados, o cliente precisa
      // escolher um. Se NÃO tem nenhum, a loja trabalha com taxa "a consultar"
      // — aceita a entrega com taxa 0 (o checkout mostra "a calcular") e o
      // bairro vai como texto livre do endereço.
      const temBairros = await get('SELECT COUNT(*) c FROM bairros WHERE loja_id=1 AND ativo=1');
      if (temBairros && Number(temBairros.c) > 0) throw new Error('Escolha o bairro para calcularmos a entrega.');
      taxa = 0;
      bairroNome = (corpo.endereco && corpo.endereco.bairro) || null;
    }
    if (!corpo.endereco || !corpo.endereco.rua || !corpo.endereco.numero) throw new Error('Informe rua e número para a entrega.');
  }

  // Fidelidade (v1.9.17): prêmio "entrega grátis" esperando resgate zera a
  // taxa deste pedido. Só consome se realmente economizar (taxa > 0).
  let premioFidelidadeId = null;
  if (tipo === 'entrega' && taxa > 0) {
    try {
      const premio = await fidelidade.premioResgatavel(whats);
      if (premio) { premioFidelidadeId = premio.id; taxa = 0; }
    } catch { /* fidelidade nunca trava a venda */ }
  }

  const itensCalc = [];
  for (const item of corpo.itens) itensCalc.push(await precificarItem(item));
  const subtotal = itensCalc.reduce((s, i) => s + i.subtotal, 0);
  if (loja.pedido_minimo_centavos > 0 && subtotal < loja.pedido_minimo_centavos) {
    throw new Error(`O pedido mínimo é de R$ ${(loja.pedido_minimo_centavos / 100).toFixed(2).replace('.', ',')}.`);
  }
  const total = subtotal + taxa;

  const forma = String(corpo.forma_pagamento || 'dinheiro');
  const metodo = String(corpo.metodo_pagamento || forma); // pix|cartao|dinheiro|pix_mp|cartao_mp|pix_asaas|cartao_asaas
  let troco = null;
  if (forma === 'dinheiro' && corpo.troco_para_centavos) {
    troco = Number(corpo.troco_para_centavos);
    if (troco < total) throw new Error('O valor para troco precisa ser maior ou igual ao total do pedido.');
  }

  const numero = loja.proximo_numero;
  const token = tokenAleatorio();
  const codigoEntrega = await gerarCodigoEntrega();
  let pedidoId;
  await tx(async (q) => {
    const info = await q.run(`INSERT INTO pedidos (loja_id, numero, token, cliente_nome, cliente_whatsapp, tipo, bairro_id, bairro_nome,
      endereco_json, forma_pagamento, metodo_pagamento, troco_para_centavos, observacao, subtotal_centavos, taxa_entrega_centavos, total_centavos, codigo_entrega)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, numero, token, nome, whats, tipo, corpo.bairro_id || null, bairroNome,
        tipo === 'entrega' ? JSON.stringify(corpo.endereco) : null,
        forma, metodo, troco, corpo.observacao || null, subtotal, taxa, total, codigoEntrega);
    pedidoId = Number(info.lastInsertRowid);
    for (const it of itensCalc) {
      const ii = await q.run('INSERT INTO pedido_itens (pedido_id, produto_id, nome_snapshot, preco_unitario_centavos, quantidade, subtotal_centavos, observacao) VALUES (?, ?, ?, ?, ?, ?, ?)',
        pedidoId, it.produto.id, it.produto.nome, it.unit, it.quantidade, it.subtotal, itemObs(corpo, it));
      for (const sn of it.snapshot) {
        await q.run('INSERT INTO pedido_item_opcoes (pedido_item_id, grupo_nome, opcao_nome, preco_adicional_centavos, excedente) VALUES (?, ?, ?, ?, ?)',
          Number(ii.lastInsertRowid), sn.grupo_nome, sn.opcao_nome, sn.preco, sn.excedente);
      }
    }
    await q.run('INSERT INTO pedido_status_historico (pedido_id, de_status, para_status, origem, autor) VALUES (?, NULL, ?, ?, ?)', pedidoId, 'NOVO', 'cliente', 'Cliente (site)');
    await q.run('UPDATE lojas SET proximo_numero = proximo_numero + 1 WHERE id=1');
    // cliente (upsert)
    await q.run(`INSERT INTO clientes (loja_id, nome, whatsapp, total_pedidos) VALUES (1, ?, ?, 1)
      ON CONFLICT(loja_id, whatsapp) DO UPDATE SET nome=excluded.nome, total_pedidos = clientes.total_pedidos + 1`, nome, whats);
    await q.run('UPDATE pedidos SET cliente_id = (SELECT id FROM clientes WHERE loja_id=1 AND whatsapp=?) WHERE id=?', whats, pedidoId);
  });

  const pedido = await getPedido(pedidoId);
  const itens = await getItensPedido(pedidoId);
  if (premioFidelidadeId) {
    try { await fidelidade.consumirPremio(premioFidelidadeId, pedidoId); } catch { /* idem */ }
  }
  await notif.notificarNovoPedido(pedido, itens);
  // Push do painel (v1.9.20): flutuante de propósito — nunca atrasa a venda.
  pushPainel.novoPedido(pedido);
  eventos.emitir('pedido', { acao: 'novo', pedido_id: pedidoId, numero });
  return { pedido, itens };
  function itemObs(corpoOriginal, it) {
    const original = (corpoOriginal.itens || []).find(x => Number(x.produto_id) === it.produto.id);
    return original && original.observacao ? String(original.observacao) : null;
  }
}

async function getPedido(id) { return get('SELECT * FROM pedidos WHERE id=?', id); }
async function getItensPedido(pedidoId) {
  const itens = await all('SELECT * FROM pedido_itens WHERE pedido_id=? ORDER BY id', pedidoId);
  for (const it of itens) {
    it.opcoes = await all('SELECT grupo_nome, opcao_nome, preco_adicional_centavos, excedente FROM pedido_item_opcoes WHERE pedido_item_id=? ORDER BY id', it.id);
  }
  return itens;
}
async function detalhePedido(pedido) {
  if (!pedido) return null;
  return {
    ...pedido,
    endereco: pedido.endereco_json ? JSON.parse(pedido.endereco_json) : null,
    itens: await getItensPedido(pedido.id),
    historico: await all('SELECT de_status, para_status, origem, motivo, autor, created_at FROM pedido_status_historico WHERE pedido_id=? ORDER BY id', pedido.id),
    notificacoes: await all('SELECT id, canal, status, ultimo_erro, created_at, enviada_em FROM notificacoes WHERE pedido_id=? ORDER BY id', pedido.id),
    pagamento: (await get('SELECT * FROM pagamentos WHERE pedido_id=? ORDER BY id DESC LIMIT 1', pedido.id)) || null,
  };
}

// ÚNICA porta de transição — painel e Telegram passam por aqui.
// `autor` = nome de quem mexeu (v1.8): o painel passa o nome do usuário da
// sessão; pelo Telegram grava 'Telegram'. Fica em pedidos.atualizado_por.
// Baixa da entrega (v1.9): ir pra ENTREGUE exige o código de entrega do
// pedido (opts.codigoEntrega). A única saída sem código é o override do
// ADMIN (opts.semCodigo + opts.ehAdmin) — fica registrado no histórico.
async function transicionar(pedidoId, para, { origem = 'painel', motivo = null, autor = null, codigoEntrega = null, semCodigo = false, ehAdmin = false } = {}) {
  const pedido = await getPedido(pedidoId);
  if (!pedido) return { ok: false, erro: 'Pedido não encontrado.' };
  const permitidos = TRANSICOES[pedido.status] || [];
  if (!permitidos.includes(para)) return { ok: false, erro: `Não é possível ir de ${pedido.status} para ${para}.` };
  if (para === 'SAIU_ENTREGA' && pedido.tipo !== 'entrega') return { ok: false, erro: 'Pedido de retirada não sai para entrega.' };
  if (para === 'CANCELADO' && !motivo) return { ok: false, erro: 'Informe o motivo do cancelamento.' };
  let motivoHistorico = motivo;
  if (para === 'ENTREGUE') {
    if (semCodigo) {
      if (!ehAdmin) return { ok: false, erro: 'Só o administrador pode entregar sem o código.', codigo: 'SEM_PERMISSAO' };
      motivoHistorico = 'Entrega confirmada sem código (admin)';
    } else {
      const informado = String(codigoEntrega == null ? '' : codigoEntrega).replace(/\D/g, '');
      const esperado = String(pedido.codigo_entrega || '').replace(/\D/g, '');
      if (!esperado || informado !== esperado) {
        return { ok: false, erro: 'Código de entrega incorreto. Peça ao cliente o código de 4 dígitos do pedido e tente de novo.', codigo: 'CODIGO_INVALIDO' };
      }
      motivoHistorico = 'Código de entrega conferido';
    }
  }
  const quem = autor || (origem === 'telegram' ? 'Telegram' : null);
  await run("UPDATE pedidos SET status=?, motivo_cancelamento=?, atualizado_por=COALESCE(?, atualizado_por), updated_at=datetime('now') WHERE id=?", para, para === 'CANCELADO' ? motivo : pedido.motivo_cancelamento, quem, pedidoId);
  // Trilha de autoria (v1.9.1): TODA transição grava QUEM fez no histórico.
  // Painel = nome da sessão (vem em `autor`); Telegram = nome do dono +
  // "(Telegram)"; sem ator humano (webhook de pagamento etc.) = "Sistema".
  let autorHistorico = autor;
  if (!autorHistorico) {
    if (origem === 'telegram') {
      const dono = await get("SELECT nome FROM usuarios WHERE perfil='admin' ORDER BY id LIMIT 1");
      autorHistorico = dono && dono.nome ? `${dono.nome} (Telegram)` : 'Telegram';
    } else {
      autorHistorico = 'Sistema';
    }
  }
  await run('INSERT INTO pedido_status_historico (pedido_id, de_status, para_status, origem, motivo, autor) VALUES (?, ?, ?, ?, ?, ?)', pedidoId, pedido.status, para, origem, motivoHistorico, autorHistorico);
  if (para === 'CANCELADO') {
    await run('UPDATE clientes SET total_cancelamentos = total_cancelamentos + 1 WHERE loja_id=1 AND whatsapp=?', pedido.cliente_whatsapp);
  }
  const atualizado = await getPedido(pedidoId);
  await notif.notificarTransicao(atualizado, para);
  // iFood (v1.12.0): pedido que veio de lá tem o status devolvido.
  if (atualizado.origem === 'ifood') {
    try { require('./ifood').aoMudarStatus(atualizado, para).catch(() => {}); } catch { /* módulo opcional */ }
  }
  // Fidelidade: entregar pode desbloquear prêmio; cancelar devolve o prêmio.
  try { await fidelidade.aoTransicionar(atualizado, para); } catch { /* nunca trava */ }
  eventos.emitir('pedido', { acao: 'transicao', pedido_id: pedidoId, numero: pedido.numero, para });
  return { ok: true, pedido: atualizado };
}

// Boot (v1.9.1): no Postgres, garante a coluna `autor` do histórico em
// bancos criados antes da v1.9.1 (no SQLite o ALTER vive no db.js).
async function preparar() {
  if (modoBanco() === 'postgres') {
    await execSql('ALTER TABLE pedido_status_historico ADD COLUMN IF NOT EXISTS autor TEXT');
    // v1.9.3: estas colunas só existiam no schema.sql — banco criado antes
    // da v1.9 (ex.: Supabase do Açaí do Guri, schema da v1.5) ficava sem elas
    // e criar pedido quebrava. O boot agora garante todas.
    await execSql('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS codigo_entrega TEXT');
    await execSql('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS entrega_provedor TEXT');
    await execSql('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS entrega_ext_id TEXT');
    await execSql('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS entrega_status TEXT');
    await execSql('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS entrega_chamada_em TEXT');
  }
}

module.exports = { getLoja, montarCardapio, criarPedido, getPedido, getItensPedido, detalhePedido, transicionar, TRANSICOES, preparar };
