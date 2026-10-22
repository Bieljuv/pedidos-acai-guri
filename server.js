'use strict';
// Servidor local do Sistema de Pedidos — Açaí do Guri.
// Rotas NÃO contêm SQL: todo acesso a dados passa por src/db.js (DAL) e pelos serviços.
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const db = require('./src/db');
const { get, all, run } = db;
const util = require('./src/util');
util.carregarEnv(path.join(__dirname, '.env'));

const pedidosCore = require('./src/pedidos');
const financeiro = require('./src/financeiro');
const equipe = require('./src/equipe');
const entregadores = require('./src/entregadores');
const notif = require('./src/notificacoes');
const pagamentos = require('./src/pagamentos');
const comanda = require('./src/comanda');
const storage = require('./src/storage');
const eventos = require('./src/eventos');

notif.setTransicaoHandler((id, para, opts) => pedidosCore.transicionar(id, para, opts));

const app = express();
app.use(express.json({ limit: '1mb' }));

// Boot do banco: init() (confere/semeia) + preparar() (cache da config de
// notificações). TODA rota /api aguarda essa promise — no SQLite é imediata;
// no Postgres (Supabase) é o que garante schema conferido e seed aplicado
// antes da primeira resposta. Se rejeitar, a API responde 500 com a causa.
const pronto = (async () => { await db.init(); await equipe.preparar(); await entregadores.preparar(); await pedidosCore.preparar(); await notif.preparar(); })();
pronto.catch((e) => console.error('[banco]', e.message));
app.use('/api', async (req, res, next) => {
  try { await pronto; next(); }
  catch { res.status(500).json({ erro: 'Banco de dados indisponível.' }); }
});

// Express 4 não captura rejeição de handler async: este wrapper encaminha
// pro middleware de erro (500 "Erro interno.") em vez de derrubar o processo.
const h = (fn) => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };

// ---------------- Auth ----------------
async function autenticar(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ erro: 'Não autenticado.' });
  const sessao = await get('SELECT * FROM sessoes WHERE token=?', token);
  if (!sessao) return res.status(401).json({ erro: 'Sessão inválida. Faça login de novo.' });
  req.usuario = await get('SELECT id, nome, login, perfil, ativo, hora_entrada, hora_saida, dias_semana, janela_antes_min, janela_depois_min FROM usuarios WHERE id=?', sessao.usuario_id);
  if (!req.usuario) return res.status(401).json({ erro: 'Usuário não encontrado.' });
  if (Number(req.usuario.ativo) === 0) return res.status(401).json({ erro: 'Usuário desativado. Fale com o administrador.' });
  req.token = token;
  next();
}
const auth = h(autenticar);

// Autorização por perfil (v1.8): a barreira é no SERVIDOR — funcionário que
// tentar chamar rota de admin recebe 403 de verdade (não é só menu escondido).
function soAdmin(req, res, next) {
  if (!req.usuario || req.usuario.perfil !== 'admin') {
    return res.status(403).json({ erro: 'Sem permissão: esta área é só do administrador.' });
  }
  next();
}

app.post('/api/auth/login', h(async (req, res) => {
  const { login, senha } = req.body || {};
  const u = await get('SELECT * FROM usuarios WHERE login=? AND ativo=1', String(login || ''));
  if (!u || !util.verificaSenha(senha || '', u.senha_hash)) return res.status(401).json({ erro: 'Login ou senha inválidos.' });
  // Funcionário só entra dentro da janela do turno (admin nunca é bloqueado).
  if (u.perfil === 'funcionario') {
    const janela = equipe.podeLogarAgora(u);
    if (!janela.ok) return res.status(403).json({ erro: janela.erro });
  }
  const token = util.tokenAleatorio(24);
  await run('INSERT INTO sessoes (token, usuario_id) VALUES (?, ?)', token, u.id);
  res.json({ token, nome: u.nome, perfil: u.perfil });
}));
app.post('/api/auth/trocar-senha', auth, h(async (req, res) => {
  const { senha_atual, nova_senha } = req.body || {};
  const u = await get('SELECT * FROM usuarios WHERE id=?', req.usuario.id);
  if (!util.verificaSenha(senha_atual || '', u.senha_hash)) return res.status(422).json({ erro: 'Senha atual incorreta.' });
  if (!nova_senha || String(nova_senha).length < 6) return res.status(422).json({ erro: 'A nova senha precisa de pelo menos 6 caracteres.' });
  await run('UPDATE usuarios SET senha_hash=? WHERE id=?', util.hashSenha(nova_senha), u.id);
  res.json({ ok: true });
}));

// ---------------- Públicas ----------------
app.get('/api/public/loja', h(async (req, res) => {
  const loja = await pedidosCore.getLoja();
  const estado = util.lojaEstaAberta(loja);
  // pix presencial: chave pode estar na loja ou no extra do meio
  const pixCfg = await pagamentos.getConfig('pix_presencial');
  const chavePix = (pixCfg && pixCfg.extra && pixCfg.extra.chave_pix) || loja.chave_pix || '';
  res.json({
    id: loja.id, nome: loja.nome, logo_url: loja.logo_url, capa_url: loja.capa_url,
    whatsapp: loja.whatsapp, instagram: loja.instagram, endereco_texto: loja.endereco_texto,
    tempo_preparo_min: loja.tempo_preparo_min, tempo_entrega_min: loja.tempo_entrega_min,
    pedido_minimo_centavos: loja.pedido_minimo_centavos, taxa_unica_centavos: loja.taxa_unica_centavos,
    chave_pix: chavePix, aberta: estado.aberta, pausada: estado.pausada, mensagem_status: estado.mensagem,
    metodos_pagamento: await pagamentos.metodosPublicos(loja),
  });
}));
app.get('/api/public/cardapio', h(async (req, res) => res.json(await pedidosCore.montarCardapio())));
app.get('/api/public/bairros', h(async (req, res) => res.json(await all('SELECT id, bairro, taxa_centavos, ativo FROM bairros WHERE loja_id=1 AND ativo=1 ORDER BY bairro'))));

app.post('/api/public/pedidos', h(async (req, res) => {
  try {
    // método online define a forma base (pix_mp/cartao_mp → provedor; forma_pagamento legado é derivado)
    const corpo = { ...(req.body || {}) };
    const metodo = String(corpo.metodo_pagamento || corpo.forma_pagamento || 'dinheiro');
    corpo.metodo_pagamento = metodo;
    if (!corpo.forma_pagamento) corpo.forma_pagamento = metodo.startsWith('pix') ? 'pix' : metodo.startsWith('cartao') ? 'cartao' : 'dinheiro';
    const { pedido } = await pedidosCore.criarPedido(corpo);
    let pagamentoResp = null;
    try {
      const pag = await pagamentos.iniciarPagamento(pedido, metodo);
      pagamentoResp = { status: pag.status, qr_texto: pag.qr_texto || null, link_pagamento: pag.link_pagamento || null };
      const pagRow = await get('SELECT status FROM pagamentos WHERE pedido_id=? ORDER BY id DESC LIMIT 1', pedido.id);
      if (pagRow && pagRow.status === 'pendente') {
        await notif.notificarDonoTexto(`Pedido #${pedido.numero} aguardando pagamento online (${metodo}).`, pedido.id);
      }
    } catch (e) {
      pagamentoResp = { status: 'erro_config' }; // nunca bloqueia a venda
    }
    res.status(201).json({ numero: pedido.numero, token: pedido.token, total_centavos: pedido.total_centavos, status: pedido.status, pagamento: pagamentoResp });
  } catch (e) {
    res.status(422).json({ erro: String(e.message || e) });
  }
}));
app.get('/api/public/pedidos/:token', h(async (req, res) => {
  const pedido = await get('SELECT * FROM pedidos WHERE token=?', req.params.token);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  res.json(await pedidosCore.detalhePedido(pedido));
}));

// ---------------- Webhooks públicos ----------------
app.post('/api/webhooks/mercadopago', async (req, res) => {
  try { await pagamentos.webhookMercadoPago(req.body || {}); } catch (e) { console.error('[webhook mp]', e.message); }
  res.status(200).json({ ok: true });
});
app.post('/api/webhooks/asaas', async (req, res) => {
  try { await pagamentos.webhookAsaas(req.body || {}, req.headers); } catch (e) { console.error('[webhook asaas]', e.message); }
  res.status(200).json({ ok: true });
});
// Telegram por webhook (produção/Vercel via setWebhook) — MESMO handler do poller local.
app.post('/api/webhooks/telegram', async (req, res) => {
  try { await notif.tratarUpdateTelegram(req.body || {}); } catch (e) { console.error('[webhook telegram]', e.message); }
  res.status(200).json({ ok: true });
});
// Webhook da 99 (v1.9.2): a entrega mudou de estado lá. Público (sem sessão);
// payload inválido ou de outra loja é ignorado com 200 — nunca 500.
app.post('/api/webhooks/entregas/99', async (req, res) => {
  try {
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      const r = await entregadores.tratarWebhook(req.body);
      if (!r.ok) console.warn('[webhook 99]', r.motivo);
    }
  } catch (e) { console.error('[webhook 99]', e.message); }
  res.status(200).json({ ok: true });
});

// ---------------- Painel: pedidos ----------------
app.get('/api/painel/pedidos', auth, h(async (req, res) => {
  const lista = await all("SELECT * FROM pedidos WHERE loja_id=1 AND date(created_at,'localtime')=date('now','localtime') ORDER BY id DESC");
  const saida = [];
  for (const p of lista) saida.push({ ...p, itens: await pedidosCore.getItensPedido(p.id) });
  res.json(saida);
}));
app.get('/api/painel/pedidos/:id', auth, h(async (req, res) => {
  const p = await pedidosCore.getPedido(Number(req.params.id));
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  res.json(await pedidosCore.detalhePedido(p));
}));
app.post('/api/painel/pedidos/:id/transicao', auth, h(async (req, res) => {
  const { para_status, motivo, codigo_entrega, sem_codigo } = req.body || {};
  const r = await pedidosCore.transicionar(Number(req.params.id), String(para_status || ''), {
    origem: 'painel', motivo: motivo || null, autor: req.usuario.nome,
    // Baixa da entrega (v1.9): o código vem do diálogo do painel; o override
    // sem código só vale se quem chamou for admin (conferido aqui e no core).
    codigoEntrega: codigo_entrega != null ? String(codigo_entrega) : null,
    semCodigo: sem_codigo === true,
    ehAdmin: req.usuario.perfil === 'admin',
  });
  if (!r.ok) return res.status(422).json({ erro: r.erro, codigo: r.codigo || undefined });
  res.json({ ok: true, pedido: r.pedido });
}));
// Entregas 99 (v1.9.2 — módulo src/entregadores.js): histórico do pedido,
// despachar (API oficial quando há credenciais ativas; sem elas, despacho
// manual registrado), consultar e cancelar. Falha na 99 NUNCA trava o pedido.
function copiaDespacho99(p, loja) {
  const cfg = entregadores.getCfg();
  const pk = cfg.pickup || {};
  const coleta = pk.logradouro
    ? [pk.logradouro + (pk.numero ? ', ' + pk.numero : ''), pk.complemento, pk.bairro, (pk.cidade || '') + (pk.uf ? '/' + pk.uf : ''), pk.cep ? 'CEP ' + pk.cep : '', pk.referencia ? 'Ref.: ' + pk.referencia : ''].filter(Boolean).join(' — ')
    : ((loja && loja.endereco_texto) || '');
  let end = {};
  try { end = p.endereco_json ? JSON.parse(p.endereco_json) : {}; } catch { end = {}; }
  const destino = [end.rua ? end.rua + (end.numero ? ', ' + end.numero : '') : '', end.complemento || '', p.bairro_nome || end.bairro || '', end.referencia ? 'Ref.: ' + end.referencia : ''].filter(Boolean).join(' — ');
  return {
    coleta,
    coleta_nome: cfg.merchantName || (loja && loja.nome) || 'Loja',
    coleta_telefone: cfg.pickupPhone || (loja && loja.whatsapp) || '',
    destino,
    cliente: p.cliente_nome || '',
    telefone: p.cliente_whatsapp || '',
    pin: p.codigo_entrega || '',
    pedido_numero: p.numero,
    total: util.fmtBRL(p.total_centavos),
  };
}
app.get('/api/painel/pedidos/:id/entregas', auth, h(async (req, res) => {
  const p = await pedidosCore.getPedido(Number(req.params.id));
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  res.json(await entregadores.entregasDoPedido(p.id));
}));
app.post('/api/painel/pedidos/:id/entregas/despachar', auth, h(async (req, res) => {
  const p = await pedidosCore.getPedido(Number(req.params.id));
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  if (p.tipo !== 'entrega') return res.status(422).json({ erro: 'Entregador só se chama em pedido de entrega.' });
  if (!['EM_PREPARO', 'PRONTO'].includes(p.status)) return res.status(422).json({ erro: 'Só dá pra chamar o entregador com o pedido em preparo ou pronto.' });
  const loja = await pedidosCore.getLoja();
  if (!entregadores.cfgPublica().configurado) {
    const entrega = await entregadores.registrarManual(p);
    return res.json({ ok: true, modo: 'manual', entrega, copia: copiaDespacho99(p, loja) });
  }
  try {
    const detalhe = await pedidosCore.detalhePedido(p);
    const entrega = await entregadores.despachar(p, (detalhe && detalhe.itens) || []);
    res.json({ ok: true, modo: '99', entrega });
  } catch (e) {
    res.status(422).json({ erro: e.message });
  }
}));
app.post('/api/painel/entregas/:id/consultar', auth, h(async (req, res) => {
  try { res.json({ ok: true, entrega: await entregadores.consultar(Number(req.params.id)) }); }
  catch (e) { res.status(422).json({ erro: e.message }); }
}));
app.post('/api/painel/entregas/:id/cancelar', auth, h(async (req, res) => {
  try { res.json({ ok: true, entrega: await entregadores.cancelar(Number(req.params.id), (req.body || {}).motivo || null) }); }
  catch (e) { res.status(422).json({ erro: e.message }); }
}));
app.post('/api/painel/pedidos/:id/imprimir', auth, h(async (req, res) => {
  const p = await pedidosCore.getPedido(Number(req.params.id));
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  const detalhe = await pedidosCore.detalhePedido(p);
  const texto = comanda.montarComanda(detalhe);
  let impressaoStatus = 'registrada';
  if (process.env.IMPRESSORA_IP) {
    const r = await comanda.enviarParaImpressora(texto);
    impressaoStatus = r.enviado ? 'impressa' : 'falhou';
    await run('INSERT INTO impressoes (pedido_id, tipo, status, erro) VALUES (?, ?, ?, ?)', p.id, 'comanda', impressaoStatus, r.enviado ? null : r.motivo);
  } else {
    await run('INSERT INTO impressoes (pedido_id, tipo, status) VALUES (?, ?, ?)', p.id, 'comanda', 'registrada');
  }
  res.json({ comanda: texto, impressao: impressaoStatus });
}));

// ---------------- Painel: CRUD genérico ----------------
const CRUD = {
  categorias: { tabela: 'categorias', campos: ['nome', 'ordem', 'ativa'], numericos: ['ordem', 'ativa'], ordemLista: 'ordem, id', colunaAtivo: 'ativa' },
  produtos: { tabela: 'produtos', campos: ['categoria_id', 'nome', 'descricao', 'foto_url', 'preco_base_centavos', 'tipo', 'destaque', 'ativo', 'esgotado', 'ordem'], numericos: ['categoria_id', 'preco_base_centavos', 'destaque', 'ativo', 'esgotado', 'ordem'], ordemLista: 'ordem, id', colunaAtivo: 'ativo' },
  grupos: { tabela: 'grupos_opcoes', campos: ['nome', 'tipo_escolha', 'minimo', 'maximo', 'obrigatorio', 'excedente_vira_pago', 'preco_excedente_centavos', 'ativo', 'ordem'], numericos: ['minimo', 'maximo', 'obrigatorio', 'excedente_vira_pago', 'preco_excedente_centavos', 'ativo', 'ordem'], ordemLista: 'ordem, id', colunaAtivo: 'ativo' },
  opcoes: { tabela: 'opcoes', campos: ['grupo_id', 'nome', 'preco_adicional_centavos', 'ativa', 'esgotada', 'ordem'], numericos: ['grupo_id', 'preco_adicional_centavos', 'ativa', 'esgotada', 'ordem'], semLoja: true, ordemLista: 'grupo_id, ordem, id', colunaAtivo: 'ativa' },
  bairros: { tabela: 'bairros', campos: ['bairro', 'taxa_centavos', 'ativo'], numericos: ['taxa_centavos', 'ativo'], ordemLista: 'bairro, id', colunaAtivo: 'ativo' },
};
function valorCampo(cfg, campo, valor) {
  if (valor === undefined) return undefined;
  if (cfg.numericos.includes(campo)) {
    if (valor === null || valor === '') return campo === 'maximo' ? null : 0;
    if (typeof valor === 'boolean') return valor ? 1 : 0;
    return Number(valor);
  }
  return valor;
}
// PUT do cardápio por funcionário (v1.8): ele só pode PAUSAR/ATIVAR produto e
// opção. A checagem compara o corpo com o registro ATUAL do banco: campo de
// alternância pode mudar; qualquer outro campo precisa vir IGUAL ao gravado
// (o front manda a linha inteira nos checkboxes) — mudou preço/nome/etc → 403.
const TOGGLES_CARDAPIO = { produtos: ['ativo', 'esgotado'], opcoes: ['ativa', 'esgotada'] };
function guardPutCardapio(recurso, cfg) {
  return h(async (req, res, next) => {
    if (req.usuario.perfil === 'admin') return next();
    const toggles = TOGGLES_CARDAPIO[recurso];
    if (!toggles) return res.status(403).json({ erro: 'Sem permissão: esta área é só do administrador.' });
    const id = Number(req.params.id);
    const atual = await get(`SELECT * FROM ${cfg.tabela} WHERE id=?`, id);
    if (!atual) return res.status(404).json({ erro: 'Registro não encontrado.' });
    const corpo = req.body || {};
    const negado = () => res.status(403).json({ erro: 'Funcionários só podem pausar/ativar itens do cardápio.' });
    for (const c of cfg.campos) {
      if (corpo[c] === undefined || toggles.includes(c)) continue;
      const novo = valorCampo(cfg, c, corpo[c]);
      const velho = atual[c];
      const igual = (novo === null && (velho === null || velho === undefined))
        || String(novo) === String(velho)
        || (cfg.numericos.includes(c) && Number(novo) === Number(velho));
      if (!igual) return negado();
    }
    if (recurso === 'produtos' && corpo.grupo_ids !== undefined) {
      if (!Array.isArray(corpo.grupo_ids)) return negado();
      const atuais = (await all('SELECT grupo_id FROM produto_grupos WHERE produto_id=?', id)).map(r => Number(r.grupo_id)).sort((a, b) => a - b);
      const novos = corpo.grupo_ids.map(Number).sort((a, b) => a - b);
      if (JSON.stringify(atuais) !== JSON.stringify(novos)) return negado();
    }
    next();
  });
}
for (const [recurso, cfg] of Object.entries(CRUD)) {
  const base = '/api/painel/' + recurso;
  app.get(base, auth, h(async (req, res) => {
    const where = cfg.semLoja ? '' : ' WHERE loja_id=1';
    res.json(await all(`SELECT * FROM ${cfg.tabela}${where} ORDER BY ${cfg.ordemLista}`));
  }));
  app.post(base, auth, soAdmin, h(async (req, res) => {
    const corpo = req.body || {};
    const campos = cfg.campos.filter(c => corpo[c] !== undefined);
    const valores = campos.map(c => valorCampo(cfg, c, corpo[c]));
    const cols = (cfg.semLoja ? campos : ['loja_id', ...campos]);
    const vals = cfg.semLoja ? valores : [1, ...valores];
    const info = await run(`INSERT INTO ${cfg.tabela} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...vals);
    const id = Number(info.lastInsertRowid);
    if (recurso === 'produtos') await salvarGruposProduto(id, corpo.grupo_ids);
    res.status(201).json(await get(`SELECT * FROM ${cfg.tabela} WHERE id=?`, id));
  }));
  const putGuard = TOGGLES_CARDAPIO[recurso] ? guardPutCardapio(recurso, cfg) : soAdmin;
  app.put(base + '/:id', auth, putGuard, h(async (req, res) => {
    const id = Number(req.params.id);
    const atual = await get(`SELECT * FROM ${cfg.tabela} WHERE id=?`, id);
    if (!atual) return res.status(404).json({ erro: 'Registro não encontrado.' });
    const corpo = req.body || {};
    const campos = cfg.campos.filter(c => corpo[c] !== undefined);
    if (campos.length) {
      await run(`UPDATE ${cfg.tabela} SET ${campos.map(c => c + '=?').join(',')} WHERE id=?`, ...campos.map(c => valorCampo(cfg, c, corpo[c])), id);
    }
    if (recurso === 'produtos' && Array.isArray(corpo.grupo_ids)) await salvarGruposProduto(id, corpo.grupo_ids);
    res.json(await get(`SELECT * FROM ${cfg.tabela} WHERE id=?`, id));
  }));
  app.delete(base + '/:id', auth, soAdmin, h(async (req, res) => {
    const id = Number(req.params.id);
    await run(`UPDATE ${cfg.tabela} SET ${cfg.colunaAtivo}=0 WHERE id=?`, id);
    res.json({ ok: true });
  }));
}
async function salvarGruposProduto(produtoId, grupoIds) {
  if (!Array.isArray(grupoIds)) return;
  await run('DELETE FROM produto_grupos WHERE produto_id=?', produtoId);
  for (let i = 0; i < grupoIds.length; i++) {
    await run('INSERT INTO produto_grupos (produto_id, grupo_id, ordem) VALUES (?, ?, ?)', produtoId, Number(grupoIds[i]), i + 1);
  }
}
app.get('/api/painel/produtos/:id/grupos', auth, h(async (req, res) => {
  res.json(await all('SELECT grupo_id, ordem FROM produto_grupos WHERE produto_id=? ORDER BY ordem', Number(req.params.id)));
}));

// ---------------- Painel: upload ----------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});
app.post('/api/painel/upload', auth, soAdmin, upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(422).json({ erro: 'Envie uma imagem (até 5MB) no campo "arquivo".' });
  try {
    const r = await storage.salvarArquivo(req.file.buffer, req.file.originalname, req.file.mimetype);
    res.json(r);
  } catch (e) {
    res.status(500).json({ erro: String(e.message || e) });
  }
});

// ---------------- Painel: loja ----------------
app.get('/api/painel/loja', auth, h(async (req, res) => res.json(await pedidosCore.getLoja())));
app.patch('/api/painel/loja', auth, soAdmin, h(async (req, res) => {
  const campos = ['nome', 'logo_url', 'capa_url', 'whatsapp', 'instagram', 'endereco_texto', 'tempo_preparo_min', 'tempo_entrega_min', 'pedido_minimo_centavos', 'taxa_unica_centavos', 'chave_pix', 'email_pedidos', 'aberta_manual', 'horario_abre', 'horario_fecha', 'som_pedido'];
  const corpo = req.body || {};
  const usar = campos.filter(c => corpo[c] !== undefined);
  if (usar.length) {
    const vals = usar.map(c => (typeof corpo[c] === 'boolean' ? (corpo[c] ? 1 : 0) : corpo[c]));
    await run(`UPDATE lojas SET ${usar.map(c => c + '=?').join(',')}, updated_at=datetime('now') WHERE id=1`, ...vals);
    eventos.emitir('loja', { acao: 'atualizada' });
  }
  res.json(await pedidosCore.getLoja());
}));
app.post('/api/painel/loja/pausar', auth, h(async (req, res) => {
  const minutos = Math.max(1, Number((req.body || {}).minutos || 30));
  const ate = new Date(Date.now() + minutos * 60000).toISOString();
  await run('UPDATE lojas SET pausada_ate=? WHERE id=1', ate);
  eventos.emitir('loja', { acao: 'pausada', ate });
  res.json({ ok: true, pausada_ate: ate });
}));
app.post('/api/painel/loja/reabrir', auth, h(async (req, res) => {
  await run('UPDATE lojas SET pausada_ate=NULL WHERE id=1');
  eventos.emitir('loja', { acao: 'reaberta' });
  res.json({ ok: true });
}));

// ---------------- Painel: Meios de Recebimento ----------------
app.get('/api/painel/recebimentos', auth, soAdmin, h(async (req, res) => res.json(await pagamentos.listarConfigMascarado())));
app.patch('/api/painel/recebimentos/:meio', auth, soAdmin, h(async (req, res) => {
  if (!pagamentos.MEIOS.includes(req.params.meio)) return res.status(404).json({ erro: 'Meio desconhecido.' });
  try { res.json(await pagamentos.atualizarConfig(req.params.meio, req.body || {})); }
  catch (e) { res.status(422).json({ erro: String(e.message || e) }); }
}));
app.post('/api/painel/recebimentos/:meio/testar', auth, soAdmin, async (req, res) => {
  if (!pagamentos.MEIOS.includes(req.params.meio)) return res.status(404).json({ erro: 'Meio desconhecido.' });
  res.json(await pagamentos.testarConexao(req.params.meio));
});

// ---------------- Painel: Financeiro (v1.1) ----------------
function tratarErroFinanceiro(res, e) {
  if (e && e.status === 422) return res.status(422).json({ erro: e.message });
  throw e;
}
app.get('/api/painel/financeiro/lancamentos', auth, soAdmin, h(async (req, res) => {
  const { data, tipo } = req.query;
  if (data && !financeiro.dataValida(String(data))) return res.status(422).json({ erro: 'Data inválida. Use o formato AAAA-MM-DD.' });
  if (tipo && !financeiro.TIPOS_LANCAMENTO.includes(String(tipo))) return res.status(422).json({ erro: 'Tipo de lançamento inválido.' });
  res.json(await financeiro.listarLancamentos({ data: data ? String(data) : null, tipo: tipo ? String(tipo) : null }));
}));
app.post('/api/painel/financeiro/lancamentos', auth, soAdmin, h(async (req, res) => {
  try { res.status(201).json(await financeiro.criarLancamento(req.body || {})); }
  catch (e) { tratarErroFinanceiro(res, e); }
}));
app.put('/api/painel/financeiro/lancamentos/:id', auth, soAdmin, h(async (req, res) => {
  try {
    const r = await financeiro.atualizarLancamento(Number(req.params.id), req.body || {});
    if (!r) return res.status(404).json({ erro: 'Lançamento não encontrado.' });
    res.json(r);
  } catch (e) { tratarErroFinanceiro(res, e); }
}));
app.delete('/api/painel/financeiro/lancamentos/:id', auth, soAdmin, h(async (req, res) => {
  if (!(await financeiro.excluirLancamento(Number(req.params.id)))) return res.status(404).json({ erro: 'Lançamento não encontrado.' });
  res.json({ ok: true });
}));
app.get('/api/painel/financeiro/insumos', auth, soAdmin, h(async (req, res) => {
  const { data } = req.query;
  if (data && !financeiro.dataValida(String(data))) return res.status(422).json({ erro: 'Data inválida. Use o formato AAAA-MM-DD.' });
  res.json(await financeiro.listarInsumos({ data: data ? String(data) : null }));
}));
app.post('/api/painel/financeiro/insumos', auth, soAdmin, h(async (req, res) => {
  try { res.status(201).json(await financeiro.criarInsumo(req.body || {})); }
  catch (e) { tratarErroFinanceiro(res, e); }
}));
app.put('/api/painel/financeiro/insumos/:id', auth, soAdmin, h(async (req, res) => {
  try {
    const r = await financeiro.atualizarInsumo(Number(req.params.id), req.body || {});
    if (!r) return res.status(404).json({ erro: 'Insumo não encontrado.' });
    res.json(r);
  } catch (e) { tratarErroFinanceiro(res, e); }
}));
app.delete('/api/painel/financeiro/insumos/:id', auth, soAdmin, h(async (req, res) => {
  if (!(await financeiro.excluirInsumo(Number(req.params.id)))) return res.status(404).json({ erro: 'Insumo não encontrado.' });
  res.json({ ok: true });
}));
app.get('/api/painel/financeiro/calculo', auth, soAdmin, h(async (req, res) => {
  // ?de=&ate= (período) têm prioridade sobre ?data= (dia) — v1.7.
  if (req.query.de !== undefined || req.query.ate !== undefined) {
    const de = String(req.query.de || '');
    const ate = String(req.query.ate || '');
    if (!financeiro.dataValida(de) || !financeiro.dataValida(ate)) return res.status(422).json({ erro: 'Período inválido. Use de=AAAA-MM-DD e ate=AAAA-MM-DD.' });
    if (de > ate) return res.status(422).json({ erro: 'Período inválido: a data inicial é depois da final.' });
    return res.json(await financeiro.calcularPeriodo(de, ate));
  }
  const data = req.query.data ? String(req.query.data) : financeiro.dataHoje();
  if (!financeiro.dataValida(data)) return res.status(422).json({ erro: 'Data inválida. Use o formato AAAA-MM-DD.' });
  res.json(await financeiro.calcular(data));
}));

// ---------------- Painel: relatório, saúde, SSE ----------------
app.get('/api/painel/relatorio/pdf', auth, soAdmin, h(async (req, res) => {
  // ?mes=AAAA-MM gera o PDF do MÊS; ?data= segue o PDF do dia (v1.7).
  if (req.query.mes !== undefined) {
    const mes = String(req.query.mes || '');
    if (!financeiro.mesValido(mes)) return res.status(422).json({ erro: 'Mês inválido. Use o formato AAAA-MM.' });
    const loja = await pedidosCore.getLoja();
    return financeiro.gerarPdfRelatorioMensal(await financeiro.relatorioMensal(mes), loja ? loja.nome : 'Loja', res);
  }
  const data = req.query.data ? String(req.query.data) : financeiro.dataHoje();
  if (!financeiro.dataValida(data)) return res.status(422).json({ erro: 'Data inválida. Use o formato AAAA-MM-DD.' });
  const loja = await pedidosCore.getLoja();
  financeiro.gerarPdfRelatorio(await financeiro.resumoRelatorio(data), loja ? loja.nome : 'Loja', res);
}));
// Relatório mensal (v1.7): JSON p/ a tela + XML gerencial p/ a contabilidade.
app.get('/api/painel/relatorio/mensal', auth, soAdmin, h(async (req, res) => {
  const mes = String(req.query.mes || '');
  if (!financeiro.mesValido(mes)) return res.status(422).json({ erro: 'Mês inválido. Use o formato AAAA-MM.' });
  res.json(await financeiro.relatorioMensal(mes));
}));
app.get('/api/painel/relatorio/mensal/xml', auth, soAdmin, h(async (req, res) => {
  const mes = String(req.query.mes || '');
  if (!financeiro.mesValido(mes)) return res.status(422).json({ erro: 'Mês inválido. Use o formato AAAA-MM.' });
  const loja = await pedidosCore.getLoja();
  const xml = financeiro.gerarXmlMensal(loja ? loja.nome : 'Loja', await financeiro.dadosXmlMensal(mes));
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="relatorio-acai-${mes}.xml"`);
  res.send(xml);
}));
app.get('/api/painel/relatorio', auth, soAdmin, h(async (req, res) => {
  const data = req.query.data ? String(req.query.data) : financeiro.dataHoje();
  if (!financeiro.dataValida(data)) return res.status(422).json({ erro: 'Data inválida. Use o formato AAAA-MM-DD.' });
  const dia = "date(created_at,'localtime')=?";
  const diaP = "date(p.created_at,'localtime')=?";
  const concluidos = await get(`SELECT COUNT(*) c, COALESCE(SUM(total_centavos),0) s FROM pedidos WHERE loja_id=1 AND ${dia} AND status='ENTREGUE'`, data);
  const cancelados = await get(`SELECT COUNT(*) c FROM pedidos WHERE loja_id=1 AND ${dia} AND status='CANCELADO'`, data);
  res.json({
    data,
    pedidos_concluidos: concluidos.c,
    cancelados: cancelados.c,
    faturamento_centavos: concluidos.s,
    ticket_medio_centavos: concluidos.c ? Math.round(concluidos.s / concluidos.c) : 0,
    top_produtos: await all(`SELECT pi.nome_snapshot AS nome, SUM(pi.quantidade) AS qtd FROM pedido_itens pi JOIN pedidos p ON p.id=pi.pedido_id WHERE ${diaP} GROUP BY pi.nome_snapshot ORDER BY qtd DESC LIMIT 10`, data),
    top_opcoes: await all(`SELECT po.opcao_nome AS nome, COUNT(*) AS qtd FROM pedido_item_opcoes po JOIN pedido_itens pi ON pi.id=po.pedido_item_id JOIN pedidos p ON p.id=pi.pedido_id WHERE ${diaP} GROUP BY po.opcao_nome ORDER BY qtd DESC LIMIT 10`, data),
    por_pagamento: {
      pix: (await get(`SELECT COUNT(*) c FROM pedidos WHERE loja_id=1 AND ${dia} AND forma_pagamento='pix'`, data)).c,
      dinheiro: (await get(`SELECT COUNT(*) c FROM pedidos WHERE loja_id=1 AND ${dia} AND forma_pagamento='dinheiro'`, data)).c,
      cartao: (await get(`SELECT COUNT(*) c FROM pedidos WHERE loja_id=1 AND ${dia} AND forma_pagamento='cartao'`, data)).c,
    },
  });
}));
app.get('/api/painel/saude', auth, h(async (req, res) => {
  let banco = 'ok';
  try { await get('SELECT 1 AS um'); } catch { banco = 'erro'; }
  res.json({
    whatsapp: { configurado: notif.evolutionConfigurado() },
    telegram: { configurado: notif.telegramConfigurado() },
    storage: storage.driver(),
    banco,
    modo_banco: db.modoBanco(),
  });
}));

// ---------------- Painel: Configurações (WhatsApp/Telegram — v1.3) ----------------
// A config vive no banco (config_notificacoes) com fallback por campo pro .env;
// segredos NUNCA voltam inteiros: GET/PUT devolvem só a versão mascarada.
app.get('/api/painel/configuracoes', auth, soAdmin, (req, res) => {
  res.json(notif.cfgPublica());
});
app.put('/api/painel/configuracoes', auth, soAdmin, h(async (req, res) => {
  const r = await notif.salvarCfg(req.body || {});
  if (!r.ok) return res.status(r.status || 422).json({ erro: r.erro });
  res.json(r.cfg);
}));
app.post('/api/painel/configuracoes/testar-whatsapp', auth, soAdmin, async (req, res) => {
  try {
    // { numero } opcional: com número, o teste ENVIA uma mensagem de verdade
    // (não é só "ping" na instância) — revisão v1.9 das configurações.
    const r = await notif.testarWhatsapp((req.body || {}).numero);
    if (r.status === 422) return res.status(422).json({ erro: r.erro });
    res.json(r);
  } catch (e) { res.status(500).json({ erro: 'Erro interno ao testar o WhatsApp.' }); }
});
app.post('/api/painel/configuracoes/testar-telegram', auth, soAdmin, async (req, res) => {
  try {
    const r = await notif.testarTelegram();
    if (r.status === 422) return res.status(422).json({ erro: r.erro });
    res.json(r);
  } catch (e) { res.status(500).json({ erro: 'Erro interno ao testar o Telegram.' }); }
});
app.post('/api/painel/configuracoes/telegram/detectar-chat', auth, soAdmin, async (req, res) => {
  try {
    res.json(await notif.detectarChatTelegram()); // nunca 500 por conflito/nada encontrado
  } catch (e) { res.json({ ok: false, mensagem: 'Não consegui procurar sua conversa agora. Abra o bot, mande um "oi", aguarde uns segundos e tente de novo.' }); }
});
// ---------------- Painel: Entregador 99 (v1.9.2, só admin) ----------------
app.get('/api/painel/entregadores/config', auth, soAdmin, (req, res) => {
  res.json(entregadores.cfgPublica());
});
app.put('/api/painel/entregadores/config', auth, soAdmin, h(async (req, res) => {
  const r = await entregadores.salvarCfg(req.body || {});
  if (!r.ok) return res.status(r.status || 422).json({ erro: r.erro });
  res.json(r.cfg);
}));
app.post('/api/painel/entregadores/testar', auth, soAdmin, h(async (req, res) => {
  res.json(await entregadores.testar());
}));

// ---------------- Painel: Equipe + Ponto (v1.8) ----------------
// Gestão (CRUD de funcionários, jornada, relatório e ajustes) = só admin.
// O ponto do PRÓPRIO usuário (hoje/entrada/saída) é de qualquer logado.
function tratarErroEquipe(res, e) {
  if (e && e.status === 422) return res.status(422).json({ erro: e.message });
  throw e;
}
app.get('/api/painel/equipe/ponto', auth, soAdmin, h(async (req, res) => {
  try { res.json(await equipe.relatorioPontoMes(String(req.query.mes || ''))); }
  catch (e) { tratarErroEquipe(res, e); }
}));
app.post('/api/painel/equipe/ponto/ajuste', auth, soAdmin, h(async (req, res) => {
  try { res.status(201).json(await equipe.lancarAjuste(req.body || {})); }
  catch (e) { tratarErroEquipe(res, e); }
}));
app.get('/api/painel/equipe', auth, soAdmin, h(async (req, res) => {
  res.json(await equipe.listarFuncionarios());
}));
app.post('/api/painel/equipe', auth, soAdmin, h(async (req, res) => {
  try { res.status(201).json(await equipe.criarFuncionario(req.body || {})); }
  catch (e) { tratarErroEquipe(res, e); }
}));
app.put('/api/painel/equipe/:id', auth, soAdmin, h(async (req, res) => {
  try {
    const r = await equipe.atualizarFuncionario(Number(req.params.id), req.body || {});
    if (!r) return res.status(404).json({ erro: 'Funcionário não encontrado.' });
    res.json(r);
  } catch (e) { tratarErroEquipe(res, e); }
}));
app.post('/api/painel/equipe/:id/senha', auth, soAdmin, h(async (req, res) => {
  try {
    const r = await equipe.redefinirSenhaFuncionario(Number(req.params.id), (req.body || {}).nova_senha);
    if (!r) return res.status(404).json({ erro: 'Funcionário não encontrado.' });
    res.json(r);
  } catch (e) { tratarErroEquipe(res, e); }
}));
app.delete('/api/painel/equipe/:id', auth, soAdmin, h(async (req, res) => {
  try {
    const r = await equipe.excluirFuncionario(Number(req.params.id));
    if (!r) return res.status(404).json({ erro: 'Funcionário não encontrado.' });
    res.json(r);
  } catch (e) { tratarErroEquipe(res, e); }
}));
app.get('/api/painel/ponto/hoje', auth, h(async (req, res) => {
  res.json(await equipe.pontoHoje(req.usuario));
}));
app.post('/api/painel/ponto/entrada', auth, h(async (req, res) => {
  try { res.status(201).json(await equipe.registrarEntrada(req.usuario)); }
  catch (e) { tratarErroEquipe(res, e); }
}));
app.post('/api/painel/ponto/saida', auth, h(async (req, res) => {
  try {
    const registro = await equipe.registrarSaida(req.usuario);
    // Bater a saída ENCERRA a sessão: o token morre aqui.
    await run('DELETE FROM sessoes WHERE token=?', req.token);
    res.status(201).json({ ok: true, saida: registro });
  } catch (e) { tratarErroEquipe(res, e); }
}));

app.get('/api/painel/stream', h(async (req, res) => {
  const sessao = await get('SELECT * FROM sessoes WHERE token=?', String(req.query.token || ''));
  if (!sessao) return res.status(401).json({ erro: 'Não autenticado.' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('event: ola\ndata: {}\n\n');
  eventos.registrarCliente(res);
}));

// ---------------- Estáticos ----------------
app.use('/uploads', express.static(storage.UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/painel', (req, res) => {
  const f = path.join(__dirname, 'public', 'painel.html');
  if (fs.existsSync(f)) res.sendFile(f); else res.status(404).send('Painel ainda não construído.');
});
app.get('/', (req, res) => {
  const f = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(f)) res.sendFile(f); else res.status(404).send('Loja ainda não construída.');
});

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(422).json({ erro: 'Arquivo maior que 5MB.' });
  console.error(err);
  res.status(500).json({ erro: 'Erro interno.' });
});

module.exports = app;

// Só escuta quando executado direto (node server.js / npm start).
// Na Vercel, quem importa é api/index.js — sem listen.
if (require.main === module) {
  const porta = Number(process.env.PORT || 3333);
  app.listen(porta, () => console.log(`Pedidos Açaí do Guri ouvindo em http://localhost:${porta} (loja / · painel /painel)`));
  // Worker de notificações/poller só no processo local, e só depois do boot
  // do banco (a cfg do Telegram vem do cache carregado no preparar()).
  pronto.then(() => notif.iniciar(), () => notif.iniciar());
}
