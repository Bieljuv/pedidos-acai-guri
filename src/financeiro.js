'use strict';
// Módulo Financeiro (v1.1) — controle interno da loja + calculadora de lucro real.
// TODAS as agregações do dia vivem aqui: GET /financeiro/calculo e o PDF do
// relatório consomem ESTAS funções (uma fonte só de cálculo).
// Dinheiro sempre em centavos (inteiro). Lançamentos usam data TEXTO YYYY-MM-DD
// escolhida pelo usuário; pedidos são filtrados pelo dia LOCAL:
// date(created_at,'localtime')=?  (nunca date(created_at) puro — bug do fuso).
const { get, all, run, execSql, modoBanco } = require('./db');

// Fontes do PDF (v1.16.6): o pdfkit carrega as fontes padrao por um
// atalho interno ("#standard-fonts") que o empacotador da Vercel NAO
// enxerga — as fontes nao subiam no deploy e TODA rota de PDF dava
// erro 500 em producao (provado por simulacao do pacote). Estes dois
// requires literais, pelos subcaminhos PUBLICOS do pacote, fazem as
// fontes usadas (Helvetica e Helvetica-Bold) entrarem no pacote.
// (A tentativa anterior via includeFiles no vercel.json fez a
// publicacao FALHAR na Vercel — esta correcao e so codigo.)
try {
  require('pdfkit/standard-fonts/Helvetica');
  require('pdfkit/standard-fonts/HelveticaBold');
} catch { /* layout do pacote mudou: o PDF segue o comportamento atual */ }

if (modoBanco() === 'sqlite') execSql(`
CREATE TABLE IF NOT EXISTS fin_lancamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER NOT NULL DEFAULT 1,
  tipo TEXT NOT NULL, -- investimento | receita_manual | despesa
  categoria TEXT, descricao TEXT,
  valor_centavos INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL, -- YYYY-MM-DD
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fin_insumos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER NOT NULL DEFAULT 1,
  nome TEXT NOT NULL, quantidade REAL NOT NULL DEFAULT 0, unidade TEXT,
  custo_total_centavos INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL, -- YYYY-MM-DD
  created_at TEXT DEFAULT (datetime('now'))
);
`);

const TIPOS_LANCAMENTO = ['investimento', 'receita_manual', 'despesa'];
const DIA_PEDIDOS = "date(p.created_at,'localtime')=?";
const PERIODO_PEDIDOS = "date(p.created_at,'localtime') BETWEEN ? AND ?";

// ---------- datas ----------
function dataHoje() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dataValida(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [a, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(a, m - 1, d);
  return dt.getFullYear() === a && dt.getMonth() === m - 1 && dt.getDate() === d;
}
function dataBR(s) { // YYYY-MM-DD -> DD/MM/YYYY
  const [a, m, d] = String(s || '').split('-');
  return a && m && d ? `${d}/${m}/${a}` : String(s || '');
}
// round half up (valores aqui são >= 0)
const roundHU = (x) => Math.floor(Number(x) + 0.5);

// ---------- validação ----------
function erro422(msg) { const e = new Error(msg); e.status = 422; return e; }
function validarLancamento(c) {
  if (!TIPOS_LANCAMENTO.includes(c.tipo)) throw erro422('Tipo de lançamento inválido. Use investimento, receita_manual ou despesa.');
  if (!Number.isInteger(c.valor_centavos) || c.valor_centavos <= 0) throw erro422('Informe um valor maior que zero.');
  if (!dataValida(c.data)) throw erro422('Data inválida. Use o formato AAAA-MM-DD.');
}
function validarInsumo(c) {
  if (!c.nome || !String(c.nome).trim()) throw erro422('Informe o nome do insumo.');
  if (!(Number(c.quantidade) > 0)) throw erro422('Informe uma quantidade maior que zero.');
  if (!Number.isInteger(c.custo_total_centavos) || c.custo_total_centavos <= 0) throw erro422('Informe um custo total maior que zero.');
  if (!dataValida(c.data)) throw erro422('Data inválida. Use o formato AAAA-MM-DD.');
}

// ---------- lançamentos ----------
async function listarLancamentos({ data, tipo } = {}) {
  const cond = ['loja_id=1'];
  const params = [];
  if (data) { cond.push('data=?'); params.push(data); }
  if (tipo) { cond.push('tipo=?'); params.push(tipo); }
  return await all(`SELECT * FROM fin_lancamentos WHERE ${cond.join(' AND ')} ORDER BY data DESC, id DESC LIMIT 200`, ...params);
}
async function criarLancamento(corpo) {
  const c = {
    tipo: String(corpo.tipo || ''),
    categoria: corpo.categoria != null ? String(corpo.categoria) : '',
    descricao: corpo.descricao != null ? String(corpo.descricao) : '',
    valor_centavos: Number(corpo.valor_centavos),
    data: corpo.data ? String(corpo.data) : dataHoje(),
  };
  validarLancamento(c);
  const info = await run('INSERT INTO fin_lancamentos (loja_id, tipo, categoria, descricao, valor_centavos, data) VALUES (1, ?, ?, ?, ?, ?)',
    c.tipo, c.categoria, c.descricao, c.valor_centavos, c.data);
  return get('SELECT * FROM fin_lancamentos WHERE id=?', Number(info.lastInsertRowid));
}
async function atualizarLancamento(id, corpo) {
  const atual = await get('SELECT * FROM fin_lancamentos WHERE id=?', id);
  if (!atual) return null;
  const c = {
    tipo: corpo.tipo !== undefined ? String(corpo.tipo) : atual.tipo,
    categoria: corpo.categoria !== undefined ? String(corpo.categoria) : atual.categoria,
    descricao: corpo.descricao !== undefined ? String(corpo.descricao) : atual.descricao,
    valor_centavos: corpo.valor_centavos !== undefined ? Number(corpo.valor_centavos) : atual.valor_centavos,
    data: corpo.data !== undefined ? String(corpo.data) : atual.data,
  };
  validarLancamento(c);
  await run('UPDATE fin_lancamentos SET tipo=?, categoria=?, descricao=?, valor_centavos=?, data=? WHERE id=?',
    c.tipo, c.categoria, c.descricao, c.valor_centavos, c.data, id);
  return get('SELECT * FROM fin_lancamentos WHERE id=?', id);
}
async function excluirLancamento(id) {
  return Number((await run('DELETE FROM fin_lancamentos WHERE id=?', id)).changes) > 0;
}

// ---------- insumos ----------
async function listarInsumos({ data } = {}) {
  if (data) return await all('SELECT * FROM fin_insumos WHERE loja_id=1 AND data=? ORDER BY id DESC LIMIT 200', data);
  return await all('SELECT * FROM fin_insumos WHERE loja_id=1 ORDER BY data DESC, id DESC LIMIT 200');
}
async function criarInsumo(corpo) {
  const c = {
    nome: corpo.nome != null ? String(corpo.nome).trim() : '',
    quantidade: Number(corpo.quantidade),
    unidade: corpo.unidade != null ? String(corpo.unidade) : '',
    custo_total_centavos: Number(corpo.custo_total_centavos),
    data: corpo.data ? String(corpo.data) : dataHoje(),
  };
  validarInsumo(c);
  const info = await run('INSERT INTO fin_insumos (loja_id, nome, quantidade, unidade, custo_total_centavos, data) VALUES (1, ?, ?, ?, ?, ?)',
    c.nome, c.quantidade, c.unidade, c.custo_total_centavos, c.data);
  return get('SELECT * FROM fin_insumos WHERE id=?', Number(info.lastInsertRowid));
}
async function atualizarInsumo(id, corpo) {
  const atual = await get('SELECT * FROM fin_insumos WHERE id=?', id);
  if (!atual) return null;
  const c = {
    nome: corpo.nome !== undefined ? String(corpo.nome).trim() : atual.nome,
    quantidade: corpo.quantidade !== undefined ? Number(corpo.quantidade) : atual.quantidade,
    unidade: corpo.unidade !== undefined ? String(corpo.unidade) : atual.unidade,
    custo_total_centavos: corpo.custo_total_centavos !== undefined ? Number(corpo.custo_total_centavos) : atual.custo_total_centavos,
    data: corpo.data !== undefined ? String(corpo.data) : atual.data,
  };
  validarInsumo(c);
  await run('UPDATE fin_insumos SET nome=?, quantidade=?, unidade=?, custo_total_centavos=?, data=? WHERE id=?',
    c.nome, c.quantidade, c.unidade, c.custo_total_centavos, c.data, id);
  return get('SELECT * FROM fin_insumos WHERE id=?', id);
}
async function excluirInsumo(id) {
  return Number((await run('DELETE FROM fin_insumos WHERE id=?', id)).changes) > 0;
}

// ---------- cálculo por período (FONTE ÚNICA — /calculo, PDF e mensal) ----------
// de/ate 'YYYY-MM-DD' INCLUSIVOS; pedidos pelo dia LOCAL (mesma semântica do
// dia: date(created_at,'localtime')); lançamentos/insumos pela coluna data.
// Lucro em DUAS camadas: operacional (vendas, sem investimento) x real
// (resultado final, depois do investimento) — pedido do primo na v1.7.
async function calcularPeriodo(de, ate) {
  const vendas = await get(
    `SELECT COUNT(*) AS c, COALESCE(SUM(p.total_centavos),0) AS s,
            COALESCE(SUM(p.taxa_entrega_centavos),0) AS taxas,
            COALESCE(SUM(CASE WHEN p.tipo='entrega' THEN 1 ELSE 0 END),0) AS entregas
       FROM pedidos p
      WHERE p.loja_id=1 AND ${PERIODO_PEDIDOS} AND p.status='ENTREGUE'`, de, ate);
  const cancelados = (await get(
    `SELECT COUNT(*) AS c FROM pedidos p WHERE p.loja_id=1 AND ${PERIODO_PEDIDOS} AND p.status='CANCELADO'`, de, ate)).c;
  const copos = (await get(
    `SELECT COALESCE(SUM(pi.quantidade),0) AS q
       FROM pedido_itens pi JOIN pedidos p ON p.id=pi.pedido_id
      WHERE p.loja_id=1 AND ${PERIODO_PEDIDOS} AND p.status='ENTREGUE'`, de, ate)).q;
  const somaTipo = async (tipo) => (await get('SELECT COALESCE(SUM(valor_centavos),0) AS s FROM fin_lancamentos WHERE loja_id=1 AND tipo=? AND data BETWEEN ? AND ?', tipo, de, ate)).s;
  const receita_manual = await somaTipo('receita_manual');
  const investimento_manual = await somaTipo('investimento');
  const despesas = await somaTipo('despesa');
  const insumos_total = (await get('SELECT COALESCE(SUM(custo_total_centavos),0) AS s FROM fin_insumos WHERE loja_id=1 AND data BETWEEN ? AND ?', de, ate)).s;

  const vendas_sistema = vendas.s;
  const pedidos_concluidos = vendas.c;
  const receita_total = vendas_sistema + receita_manual;
  const custo_total = insumos_total + despesas + investimento_manual;
  const lucro_real = receita_total - custo_total;
  // Sem o investimento: quanto as VENDAS deram (o investimento é decisão do
  // dono, não custo da operação do período).
  const lucro_operacional = receita_total - (insumos_total + despesas);
  const preco_medio_copo = copos > 0 ? roundHU(vendas_sistema / copos) : 0;
  const custo_por_copo = copos > 0 ? roundHU(custo_total / copos) : 0;

  return {
    data: de === ate ? de : null,
    de,
    ate,
    vendas_sistema,
    pedidos_concluidos,
    cancelados,
    copos,
    taxas_entrega: vendas.taxas,
    entregas: vendas.entregas,
    receita_manual,
    receitas_manuais_centavos: receita_manual, // alias p/ relatório/XML
    receita_total,
    investimento_manual,
    investimento_centavos: investimento_manual, // alias p/ relatório/XML
    insumos_total,
    insumos_centavos: insumos_total, // alias p/ relatório/XML
    despesas,
    despesas_centavos: despesas, // alias p/ relatório/XML
    custo_total,
    lucro_operacional_centavos: lucro_operacional,
    lucro_real,
    lucro_real_centavos: lucro_real, // alias p/ relatório/XML
    preco_medio_copo,
    custo_por_copo,
    lucro_por_copo: preco_medio_copo - custo_por_copo,
    custo_medio_entrega: vendas.entregas > 0 ? roundHU(despesas / vendas.entregas) : 0,
  };
}
// O dia é o período de 1 dia — números e comportamento idênticos aos de antes.
async function calcular(data) {
  return calcularPeriodo(data, data);
}

// ---------- resumo do relatório (tela + PDF, mesmo dia) ----------
const FAMILIA_PAGAMENTO = `COALESCE(NULLIF(p.forma_pagamento,''),
  CASE WHEN p.metodo_pagamento LIKE 'pix%' THEN 'pix'
       WHEN p.metodo_pagamento LIKE 'cartao%' THEN 'cartao'
       ELSE 'dinheiro' END)`;
async function resumoRelatorio(data) {
  const calc = await calcular(data);
  const top_produtos = await all(
    `SELECT pi.nome_snapshot AS nome, SUM(pi.quantidade) AS qtd, SUM(pi.subtotal_centavos) AS valor_centavos
       FROM pedido_itens pi JOIN pedidos p ON p.id=pi.pedido_id
      WHERE p.loja_id=1 AND ${DIA_PEDIDOS} AND p.status='ENTREGUE'
      GROUP BY pi.nome_snapshot ORDER BY qtd DESC LIMIT 10`, data);
  const top_opcoes = await all(
    `SELECT po.opcao_nome AS nome, COUNT(*) AS qtd
       FROM pedido_item_opcoes po
       JOIN pedido_itens pi ON pi.id=po.pedido_item_id
       JOIN pedidos p ON p.id=pi.pedido_id
      WHERE p.loja_id=1 AND ${DIA_PEDIDOS} AND p.status='ENTREGUE'
      GROUP BY po.opcao_nome ORDER BY qtd DESC LIMIT 10`, data);
  const familias = { pix: { pedidos: 0, valor_centavos: 0 }, dinheiro: { pedidos: 0, valor_centavos: 0 }, cartao: { pedidos: 0, valor_centavos: 0 } };
  for (const r of await all(
    `SELECT ${FAMILIA_PAGAMENTO} AS familia, COUNT(*) AS c, COALESCE(SUM(p.total_centavos),0) AS s
       FROM pedidos p WHERE p.loja_id=1 AND ${DIA_PEDIDOS} AND p.status='ENTREGUE'
      GROUP BY familia`, data)) {
    if (familias[r.familia]) familias[r.familia] = { pedidos: r.c, valor_centavos: r.s };
  }
  return {
    data,
    pedidos_concluidos: calc.pedidos_concluidos,
    cancelados: calc.cancelados,
    faturamento_centavos: calc.vendas_sistema,
    ticket_medio_centavos: calc.pedidos_concluidos ? roundHU(calc.vendas_sistema / calc.pedidos_concluidos) : 0,
    top_produtos,
    top_opcoes,
    por_pagamento: familias,
    financeiro: calc,
  };
}

// ---------- relatório mensal (v1.7 — JSON + XML p/ contabilidade) ----------
function mesValido(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}$/.test(s)) return false;
  const [a, m] = s.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  const dt = new Date(a, m - 1, 1);
  return dt.getFullYear() === a && dt.getMonth() === m - 1;
}
function limitesDoMes(mes) { // mes 'YYYY-MM' válido -> { primeiro, ultimo } 'YYYY-MM-DD'
  const [a, m] = mes.split('-').map(Number);
  const ultimoDia = new Date(a, m, 0).getDate();
  const p = (n) => String(n).padStart(2, '0');
  return { primeiro: `${a}-${p(m)}-01`, ultimo: `${a}-${p(m)}-${p(ultimoDia)}` };
}

async function relatorioMensal(mes) {
  const { primeiro, ultimo } = limitesDoMes(mes);
  const conclPorDia = await all(
    `SELECT date(p.created_at,'localtime') AS dia, COUNT(*) AS c, COALESCE(SUM(p.total_centavos),0) AS s
       FROM pedidos p
      WHERE p.loja_id=1 AND ${PERIODO_PEDIDOS} AND p.status='ENTREGUE'
      GROUP BY dia ORDER BY dia`, primeiro, ultimo);
  const cancPorDia = await all(
    `SELECT date(p.created_at,'localtime') AS dia, COUNT(*) AS c
       FROM pedidos p
      WHERE p.loja_id=1 AND ${PERIODO_PEDIDOS} AND p.status='CANCELADO'
      GROUP BY dia ORDER BY dia`, primeiro, ultimo);
  const cancMap = new Map(cancPorDia.map((r) => [r.dia, r.c]));
  const diasSet = new Set([...conclPorDia.map((r) => r.dia), ...cancPorDia.map((r) => r.dia)]);
  const dias = [...diasSet].sort().map((dia) => {
    const v = conclPorDia.find((r) => r.dia === dia);
    const concl = v ? v.c : 0;
    const fat = v ? v.s : 0;
    return {
      data: dia,
      pedidos_concluidos: concl,
      pedidos_cancelados: cancMap.get(dia) || 0,
      faturamento_centavos: fat,
      ticket_medio_centavos: concl ? roundHU(fat / concl) : 0,
    };
  });
  const totais = {
    pedidos_concluidos: dias.reduce((s, d) => s + d.pedidos_concluidos, 0),
    pedidos_cancelados: dias.reduce((s, d) => s + d.pedidos_cancelados, 0),
    faturamento_centavos: dias.reduce((s, d) => s + d.faturamento_centavos, 0),
    ticket_medio_centavos: 0,
  };
  totais.ticket_medio_centavos = totais.pedidos_concluidos
    ? roundHU(totais.faturamento_centavos / totais.pedidos_concluidos) : 0;
  // Mesma família de pagamento do resumo diário (forma_pagamento, com
  // fallback pelo método) — aqui em lista, como pede o contrato do mensal.
  const por_pagamento = await all(
    `SELECT ${FAMILIA_PAGAMENTO} AS forma, COUNT(*) AS qtd, COALESCE(SUM(p.total_centavos),0) AS total_centavos
       FROM pedidos p
      WHERE p.loja_id=1 AND ${PERIODO_PEDIDOS} AND p.status='ENTREGUE'
      GROUP BY forma ORDER BY forma`, primeiro, ultimo);
  return { mes, dias, totais, por_pagamento, financeiro: await calcularPeriodo(primeiro, ultimo) };
}

// ---------- XML mensal (relatório GERENCIAL — não é documento fiscal) ----------
function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
// created_at é UTC no banco; no XML sai no horário local (America/Sao_Paulo).
const fmtTsLocal = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
function dataHoraLocal(iso) {
  const s = String(iso || '');
  const d = new Date(/Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? s : fmtTsLocal.format(d);
}
async function dadosXmlMensal(mes) {
  const { primeiro, ultimo } = limitesDoMes(mes);
  const rel = await relatorioMensal(mes);
  const pedidos = await all(
    `SELECT p.numero, p.created_at, p.cliente_nome, p.tipo, p.forma_pagamento, p.status,
            p.subtotal_centavos, p.taxa_entrega_centavos, p.total_centavos
       FROM pedidos p
      WHERE p.loja_id=1 AND ${PERIODO_PEDIDOS}
      ORDER BY p.created_at, p.id`, primeiro, ultimo);
  const lancamentos = await all(
    'SELECT data, tipo, descricao, valor_centavos FROM fin_lancamentos WHERE loja_id=1 AND data BETWEEN ? AND ? ORDER BY data, id',
    primeiro, ultimo);
  const insumos = await all(
    'SELECT data, nome, quantidade, unidade, custo_total_centavos FROM fin_insumos WHERE loja_id=1 AND data BETWEEN ? AND ? ORDER BY data, id',
    primeiro, ultimo);
  return { rel, pedidos, lancamentos, insumos };
}
function gerarXmlMensal(nomeLoja, { rel, pedidos, lancamentos, insumos }) {
  const fin = rel.financeiro;
  const tot = rel.totais;
  const at = (v) => escapeXml(v);
  const linhas = [];
  linhas.push('<?xml version="1.0" encoding="UTF-8"?>');
  linhas.push('<!-- Relatorio gerencial - nao e documento fiscal -->');
  linhas.push(`<relatorio_mensal loja="${at(nomeLoja)}" mes="${at(rel.mes)}" moeda="BRL" gerado_em="${new Date().toISOString()}">`);
  linhas.push(`  <resumo faturamento_centavos="${tot.faturamento_centavos}" pedidos_concluidos="${tot.pedidos_concluidos}" pedidos_cancelados="${tot.pedidos_cancelados}" ticket_medio_centavos="${tot.ticket_medio_centavos}" receitas_manuais_centavos="${fin.receita_manual}" insumos_centavos="${fin.insumos_total}" despesas_centavos="${fin.despesas}" investimentos_centavos="${fin.investimento_manual}" lucro_operacional_centavos="${fin.lucro_operacional_centavos}" lucro_real_centavos="${fin.lucro_real}"/>`);
  linhas.push('  <vendas>');
  for (const p of pedidos) {
    linhas.push(`    <pedido numero="${p.numero}" data="${at(dataHoraLocal(p.created_at))}" cliente="${at(p.cliente_nome)}" tipo="${at(p.tipo)}" forma_pagamento="${at(p.forma_pagamento)}" status="${at(p.status)}" subtotal_centavos="${p.subtotal_centavos}" taxa_entrega_centavos="${p.taxa_entrega_centavos}" total_centavos="${p.total_centavos}"/>`);
  }
  linhas.push('  </vendas>');
  linhas.push('  <lancamentos>');
  for (const l of lancamentos) {
    linhas.push(`    <lancamento data="${at(l.data)}" tipo="${at(l.tipo)}" descricao="${at(l.descricao)}" valor_centavos="${l.valor_centavos}"/>`);
  }
  for (const i of insumos) {
    const qtd = `${i.quantidade}${i.unidade ? ' ' + i.unidade : ''}`;
    linhas.push(`    <lancamento data="${at(i.data)}" tipo="insumo" descricao="${at(`${i.nome} (${qtd})`)}" valor_centavos="${i.custo_total_centavos}"/>`);
  }
  linhas.push('  </lancamentos>');
  linhas.push('  <por_pagamento>');
  for (const f of rel.por_pagamento) {
    linhas.push(`    <forma nome="${at(f.forma)}" qtd="${f.qtd}" total_centavos="${f.total_centavos}"/>`);
  }
  linhas.push('  </por_pagamento>');
  linhas.push('</relatorio_mensal>');
  return linhas.join('\n') + '\n';
}

// ---------- PDF do relatório ----------
const fmtMoeda = (cent) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(cent || 0) / 100);
function gerarPdfRelatorio(resumo, nomeLoja, res) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="relatorio-${resumo.data}.pdf"`);
  doc.pipe(res);

  const ROXO = '#7E047D', ESCURO = '#2A0530', CINZA = '#666666';
  const fin = resumo.financeiro;
  const linha = (rotulo, valor, opts = {}) => {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 11)
      .fillColor(opts.color || ESCURO)
      .text(rotulo, 48, doc.y, { continued: true })
      .text(valor, { align: 'right' });
    doc.moveDown(opts.gap != null ? opts.gap : 0.25);
  };
  const titulo = (t) => {
    doc.moveDown(0.6).font('Helvetica-Bold').fontSize(13).fillColor(ROXO).text(t);
    doc.moveTo(48, doc.y + 2).lineTo(547, doc.y + 2).strokeColor(ROXO).lineWidth(1).stroke();
    doc.moveDown(0.5).fillColor(ESCURO);
  };

  // Cabeçalho
  doc.font('Helvetica-Bold').fontSize(20).fillColor(ROXO).text(nomeLoja || 'Loja');
  doc.font('Helvetica').fontSize(13).fillColor(ESCURO).text(`Relatório do dia — ${dataBR(resumo.data)}`);
  doc.moveDown(0.4);

  titulo('VENDAS');
  linha('Pedidos concluídos', String(resumo.pedidos_concluidos));
  linha('Pedidos cancelados', String(resumo.cancelados));
  linha('Faturamento', fmtMoeda(resumo.faturamento_centavos), { bold: true });
  linha('Ticket médio', fmtMoeda(resumo.ticket_medio_centavos));

  titulo('POR FORMA DE PAGAMENTO');
  linha('Pix', `${resumo.por_pagamento.pix.pedidos} pedido(s) — ${fmtMoeda(resumo.por_pagamento.pix.valor_centavos)}`);
  linha('Dinheiro', `${resumo.por_pagamento.dinheiro.pedidos} pedido(s) — ${fmtMoeda(resumo.por_pagamento.dinheiro.valor_centavos)}`);
  linha('Cartão', `${resumo.por_pagamento.cartao.pedidos} pedido(s) — ${fmtMoeda(resumo.por_pagamento.cartao.valor_centavos)}`);

  titulo('TOP PRODUTOS');
  if (!resumo.top_produtos.length) doc.font('Helvetica').fontSize(11).text('Nenhuma venda concluída neste dia.');
  for (const p of resumo.top_produtos) linha(`${p.nome} × ${p.qtd}`, fmtMoeda(p.valor_centavos));

  titulo('TOP OPÇÕES');
  if (!resumo.top_opcoes.length) doc.font('Helvetica').fontSize(11).text('Nenhuma opção registrada neste dia.');
  for (const o of resumo.top_opcoes) linha(`${o.nome}`, `× ${o.qtd}`);

  titulo('FINANCEIRO DO DIA');
  linha('Vendas do sistema', fmtMoeda(fin.vendas_sistema));
  linha('Receitas manuais', fmtMoeda(fin.receita_manual));
  linha('Receita acumulada', fmtMoeda(fin.receita_total), { bold: true });
  linha('Investimento', fmtMoeda(fin.investimento_manual));
  linha('Insumos', fmtMoeda(fin.insumos_total));
  linha('Despesas', fmtMoeda(fin.despesas));
  linha('Custo total', fmtMoeda(fin.custo_total));
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(16).fillColor(fin.lucro_real >= 0 ? '#1A7F37' : '#C0392B')
    .text(`LUCRO REAL: ${fmtMoeda(fin.lucro_real)}`);
  doc.font('Helvetica').fontSize(11).fillColor(ESCURO)
    .text(`Custo por copo: ${fmtMoeda(fin.custo_por_copo)} · Preço médio por copo: ${fmtMoeda(fin.preco_medio_copo)} · Lucro por copo: ${fmtMoeda(fin.lucro_por_copo)}`);

  // Rodapé
  const agoraLocal = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  doc.font('Helvetica').fontSize(9).fillColor(CINZA)
    .text(`Gerado em ${agoraLocal} — Sistema de Pedidos`, 48, 780, { align: 'center' });
  doc.end();
}

// ---------- PDF do relatório MENSAL (v1.7) ----------
const ROTULO_FORMA = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', pix_mp: 'Pix (MP)', cartao_mp: 'Cartão (MP)', pix_asaas: 'Pix (Asaas)', cartao_asaas: 'Cartão (Asaas)' };
function gerarPdfRelatorioMensal(rel, nomeLoja, res) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="relatorio-mensal-${rel.mes}.pdf"`);
  doc.pipe(res);

  const ROXO = '#7E047D', ESCURO = '#2A0530', CINZA = '#666666';
  const fin = rel.financeiro;
  const linha = (rotulo, valor, opts = {}) => {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 11)
      .fillColor(opts.color || ESCURO)
      .text(rotulo, 48, doc.y, { continued: true })
      .text(valor, { align: 'right' });
    doc.moveDown(opts.gap != null ? opts.gap : 0.25);
  };
  const titulo = (t) => {
    doc.moveDown(0.6).font('Helvetica-Bold').fontSize(13).fillColor(ROXO).text(t);
    doc.moveTo(48, doc.y + 2).lineTo(547, doc.y + 2).strokeColor(ROXO).lineWidth(1).stroke();
    doc.moveDown(0.5).fillColor(ESCURO);
  };

  // Cabeçalho — "Relatório mensal — <mês por extenso>/<ano>"
  const [ano, mesNum] = rel.mes.split('-').map(Number);
  const mesExtenso = new Date(ano, mesNum - 1, 1).toLocaleDateString('pt-BR', { month: 'long' });
  doc.font('Helvetica-Bold').fontSize(20).fillColor(ROXO).text(nomeLoja || 'Loja');
  doc.font('Helvetica').fontSize(13).fillColor(ESCURO).text(`Relatório mensal — ${mesExtenso}/${ano}`);
  doc.moveDown(0.4);

  titulo('RESUMO DO MÊS');
  linha('Pedidos concluídos', String(rel.totais.pedidos_concluidos));
  linha('Pedidos cancelados', String(rel.totais.pedidos_cancelados));
  linha('Faturamento', fmtMoeda(rel.totais.faturamento_centavos), { bold: true });
  linha('Ticket médio', fmtMoeda(rel.totais.ticket_medio_centavos));

  titulo('POR FORMA DE PAGAMENTO');
  if (!rel.por_pagamento.length) doc.font('Helvetica').fontSize(11).text('Nenhuma venda concluída neste mês.');
  for (const f of rel.por_pagamento) {
    linha(ROTULO_FORMA[f.forma] || f.forma, `${f.qtd} pedido(s) — ${fmtMoeda(f.total_centavos)}`);
  }

  titulo('VENDAS POR DIA');
  let y = doc.y;
  const cel = (txt, x, w, align, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(ESCURO)
      .text(String(txt), x, y, { width: w, align: align || 'left', lineBreak: false });
  };
  const novaPaginaSePreciso = () => { if (y > 740) { doc.addPage(); y = 56; } };
  cel('Data', 48, 90, 'left', true);
  cel('Concluídos', 140, 80, 'right', true);
  cel('Cancelados', 228, 90, 'right', true);
  cel('Faturamento', 326, 110, 'right', true);
  cel('Ticket médio', 444, 103, 'right', true);
  y += 15;
  doc.moveTo(48, y).lineTo(547, y).strokeColor(ROXO).lineWidth(0.7).stroke();
  y += 5;
  if (!rel.dias.length) { doc.font('Helvetica').fontSize(11).text('Nenhum pedido neste mês.', 48, y); y += 16; }
  for (const d of rel.dias) {
    novaPaginaSePreciso();
    cel(dataBR(d.data), 48, 90);
    cel(d.pedidos_concluidos, 140, 80, 'right');
    cel(d.pedidos_cancelados, 228, 90, 'right');
    cel(fmtMoeda(d.faturamento_centavos), 326, 110, 'right');
    cel(fmtMoeda(d.ticket_medio_centavos), 444, 103, 'right');
    y += 15;
  }
  y += 2;
  doc.moveTo(48, y).lineTo(547, y).strokeColor(ROXO).lineWidth(0.7).stroke();
  y += 5;
  novaPaginaSePreciso();
  cel('TOTAL', 48, 90, 'left', true);
  cel(rel.totais.pedidos_concluidos, 140, 80, 'right', true);
  cel(rel.totais.pedidos_cancelados, 228, 90, 'right', true);
  cel(fmtMoeda(rel.totais.faturamento_centavos), 326, 110, 'right', true);
  cel(fmtMoeda(rel.totais.ticket_medio_centavos), 444, 103, 'right', true);
  doc.y = y + 16;

  titulo('FINANCEIRO DO MÊS');
  linha('Vendas do sistema', fmtMoeda(fin.vendas_sistema));
  linha('Receitas manuais', fmtMoeda(fin.receita_manual));
  linha('Receita acumulada', fmtMoeda(fin.receita_total), { bold: true });
  linha('Investimento', fmtMoeda(fin.investimento_manual));
  linha('Insumos', fmtMoeda(fin.insumos_total));
  linha('Despesas', fmtMoeda(fin.despesas));
  linha('Custo total', fmtMoeda(fin.custo_total));
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(14).fillColor(fin.lucro_operacional_centavos >= 0 ? '#1A7F37' : '#C0392B')
    .text(`LUCRO DAS VENDAS (OPERACIONAL): ${fmtMoeda(fin.lucro_operacional_centavos)}`);
  doc.font('Helvetica-Bold').fontSize(16).fillColor(fin.lucro_real >= 0 ? '#1A7F37' : '#C0392B')
    .text(`RESULTADO APÓS INVESTIMENTOS: ${fmtMoeda(fin.lucro_real)}`);
  doc.font('Helvetica').fontSize(11).fillColor(ESCURO)
    .text(`Custo por copo: ${fmtMoeda(fin.custo_por_copo)} · Preço médio por copo: ${fmtMoeda(fin.preco_medio_copo)} · Lucro por copo: ${fmtMoeda(fin.lucro_por_copo)}`);

  const agoraLocal = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  doc.font('Helvetica').fontSize(9).fillColor(CINZA)
    .text(`Gerado em ${agoraLocal} — Sistema de Pedidos`, 48, 780, { align: 'center' });
  doc.end();
}

module.exports = {
  TIPOS_LANCAMENTO, dataHoje, dataValida, dataBR, roundHU, mesValido, limitesDoMes,
  listarLancamentos, criarLancamento, atualizarLancamento, excluirLancamento,
  listarInsumos, criarInsumo, atualizarInsumo, excluirInsumo,
  calcular, calcularPeriodo, resumoRelatorio, relatorioMensal,
  dadosXmlMensal, gerarXmlMensal, escapeXml,
  gerarPdfRelatorio, gerarPdfRelatorioMensal,
};
