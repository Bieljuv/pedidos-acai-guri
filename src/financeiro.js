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
  // No Postgres o dia volta como objeto Date (no SQLite, texto) — sem
  // tratar, o PDF imprimia o Date cru ("Fri Oct 23 2026 00:00:00...").
  if (s instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(s.getDate())}/${p(s.getMonth() + 1)}/${s.getFullYear()}`;
  }
  const [a, m, d] = String(s || '').split('-');
  return a && m && d ? `${d}/${m}/${a}` : String(s || '');
}
function diaISO(d) { // Date ou texto -> 'YYYY-MM-DD'
  if (d instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return String(d || '');
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
  // Motoboys (v1.16.23): só o pagamento CONFIRMADO entra como gasto, no
  // dia em que foi confirmado — o "a receber" ainda não é despesa.
  const motoboy = (await get(`SELECT COALESCE(SUM(valor_centavos),0) AS s FROM motoboy_pagamentos WHERE loja_id=1 AND date(created_at,'localtime') BETWEEN ? AND ?`, de, ate)).s;
  const insumos_total = (await get('SELECT COALESCE(SUM(custo_total_centavos),0) AS s FROM fin_insumos WHERE loja_id=1 AND data BETWEEN ? AND ?', de, ate)).s;

  const vendas_sistema = vendas.s;
  const pedidos_concluidos = vendas.c;
  const receita_total = vendas_sistema + receita_manual;
  const custo_total = insumos_total + despesas + investimento_manual + motoboy;
  const lucro_real = receita_total - custo_total;
  // Sem o investimento: quanto as VENDAS deram (o investimento é decisão do
  // dono, não custo da operação do período). Motoboy É custo operacional.
  const lucro_operacional = receita_total - (insumos_total + despesas + motoboy);
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
    motoboy_total: motoboy,
    motoboy_centavos: motoboy, // alias p/ relatório/XML
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
  for (const r of [...conclPorDia, ...cancPorDia]) r.dia = diaISO(r.dia); // PG devolve Date; SQLite, texto
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
  const motoboyPagamentos = await all(
    `SELECT mp.created_at, mp.valor_centavos, mp.modelo, u.nome AS motoboy_nome FROM motoboy_pagamentos mp LEFT JOIN usuarios u ON u.id = mp.motoboy_id WHERE mp.loja_id=1 AND date(mp.created_at,'localtime') BETWEEN ? AND ? ORDER BY mp.created_at, mp.id`,
    primeiro, ultimo);
  return { rel, pedidos, lancamentos, insumos, motoboyPagamentos };
}
function gerarXmlMensal(nomeLoja, { rel, pedidos, lancamentos, insumos, motoboyPagamentos }) {
  const fin = rel.financeiro;
  const tot = rel.totais;
  const at = (v) => escapeXml(v);
  const linhas = [];
  linhas.push('<?xml version="1.0" encoding="UTF-8"?>');
  linhas.push('<!-- Relatorio gerencial - nao e documento fiscal -->');
  linhas.push(`<relatorio_mensal loja="${at(nomeLoja)}" mes="${at(rel.mes)}" moeda="BRL" gerado_em="${new Date().toISOString()}">`);
  linhas.push(`  <resumo faturamento_centavos="${tot.faturamento_centavos}" pedidos_concluidos="${tot.pedidos_concluidos}" pedidos_cancelados="${tot.pedidos_cancelados}" ticket_medio_centavos="${tot.ticket_medio_centavos}" receitas_manuais_centavos="${fin.receita_manual}" insumos_centavos="${fin.insumos_total}" despesas_centavos="${fin.despesas}" investimentos_centavos="${fin.investimento_manual}" motoboy_centavos="${fin.motoboy_total}" lucro_operacional_centavos="${fin.lucro_operacional_centavos}" lucro_real_centavos="${fin.lucro_real}"/>`);
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
  linhas.push('  <pagamentos_motoboy>');
  for (const pg of (motoboyPagamentos || [])) {
    linhas.push(`    <pagamento data="${at(dataHoraLocal(pg.created_at))}" motoboy="${at(pg.motoboy_nome || '')}" modelo="${at(pg.modelo)}" valor_centavos="${pg.valor_centavos}"/>`);
  }
  linhas.push('  </pagamentos_motoboy>');
  linhas.push('  <por_pagamento>');
  for (const f of rel.por_pagamento) {
    linhas.push(`    <forma nome="${at(f.forma)}" qtd="${f.qtd}" total_centavos="${f.total_centavos}"/>`);
  }
  linhas.push('  </por_pagamento>');
  linhas.push('</relatorio_mensal>');
  return linhas.join('\n') + '\n';
}

// ---------- PDF dos relatórios (visual limpo — v1.16.12) ----------
/* Pedido do Gabriel: relatorio NAO precisa das cores do sistema.
   Documento normal — preto e cinza, linhas finas — com a LOGO da
   loja no cabecalho (a logo salva no cadastro da loja). */
const fmtMoeda = (cent) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(cent || 0) / 100);

/* Carrega os bytes da logo da loja: URL externa (Supabase Storage)
   via fetch, ou arquivo local de public/. Qualquer falha = sem logo
   (o relatorio sai so com o nome — nunca trava por causa dela). */
async function carregarLogo(logoUrl) {
  try {
    if (!logoUrl) return null;
    if (/^https?:\/\//i.test(logoUrl)) {
      const r = await fetch(logoUrl, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    }
    if (logoUrl.startsWith('/')) {
      const fs = require('fs');
      const path = require('path');
      const base = path.join(__dirname, '..', 'public');
      const alvo = path.normalize(path.join(base, logoUrl));
      if (!alvo.startsWith(base)) return null;
      return fs.readFileSync(alvo);
    }
    return null;
  } catch { return null; }
}

function abrirDocRelatorio(res, filename) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  return doc;
}

const PDF_PRETO = '#141414', PDF_CINZA = '#5A5A5A', PDF_LINHA = '#C9C9C9';
function pecasRelatorio(doc) {
  const linha = (rotulo, valor, opts = {}) => {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 11)
      .fillColor(PDF_PRETO)
      .text(rotulo, 48, doc.y, { continued: true })
      .text(valor, { align: 'right' });
    doc.moveDown(opts.gap != null ? opts.gap : 0.25);
  };
  const titulo = (t) => {
    // x forcado em 48: depois da tabela de dias o cursor x do pdfkit
    // fica deslocado e o titulo nascia no meio da pagina.
    doc.x = 48;
    doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor(PDF_PRETO).text(t, 48, doc.y);
    doc.moveTo(48, doc.y + 2).lineTo(547, doc.y + 2).strokeColor(PDF_LINHA).lineWidth(0.8).stroke();
    doc.moveDown(0.5);
  };
  const rodape = () => {
    const agoraLocal = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    doc.font('Helvetica').fontSize(9).fillColor(PDF_CINZA)
      .text(`Gerado em ${agoraLocal} — Sistema de Pedidos`, 48, 780, { align: 'center' });
  };
  return { linha, titulo, rodape };
}

/* Cabecalho: a logo da loja (se houver e o pdfkit conseguir usar —
   PNG/JPEG) ao lado do nome; senao, so o nome. Tudo em preto/cinza. */
function cabecalhoRelatorio(doc, nomeLoja, logoBuffer, subtitulo) {
  let textoX = 48;
  if (logoBuffer) {
    try {
      const img = doc.openImage(logoBuffer);
      const escala = Math.min(48 / img.height, 170 / img.width);
      const w = Math.round(img.width * escala), h = Math.round(img.height * escala);
      doc.image(img, 48, 44, { width: w, height: h });
      textoX = 48 + w + 14;
      doc.y = 44;
    } catch { textoX = 48; /* formato nao suportado: segue sem logo */ }
  }
  doc.font('Helvetica-Bold').fontSize(19).fillColor(PDF_PRETO).text(nomeLoja || 'Loja', textoX, 48, { width: 547 - textoX });
  doc.font('Helvetica').fontSize(12).fillColor(PDF_CINZA).text(subtitulo, textoX, doc.y + 2, { width: 547 - textoX });
  doc.x = 48;
  doc.y = Math.max(doc.y + 6, 104);
  doc.moveTo(48, doc.y).lineTo(547, doc.y).strokeColor(PDF_LINHA).lineWidth(0.8).stroke();
  doc.moveDown(0.4);
}

function gerarPdfRelatorio(resumo, lojaInfo, res) {
  const doc = abrirDocRelatorio(res, `relatorio-${resumo.data}.pdf`);
  const { linha, titulo, rodape } = pecasRelatorio(doc);
  const fin = resumo.financeiro;
  const nome = typeof lojaInfo === 'string' ? lojaInfo : (lojaInfo && lojaInfo.nome);
  const logo = lojaInfo && typeof lojaInfo === 'object' ? lojaInfo.logo : null;

  cabecalhoRelatorio(doc, nome, logo, `Relatório do dia — ${dataBR(resumo.data)}`);

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
  if (!resumo.top_produtos.length) doc.font('Helvetica').fontSize(11).fillColor(PDF_PRETO).text('Nenhuma venda concluída neste dia.');
  for (const p of resumo.top_produtos) linha(`${p.nome} × ${p.qtd}`, fmtMoeda(p.valor_centavos));

  titulo('TOP OPÇÕES');
  if (!resumo.top_opcoes.length) doc.font('Helvetica').fontSize(11).fillColor(PDF_PRETO).text('Nenhuma opção registrada neste dia.');
  for (const o of resumo.top_opcoes) linha(`${o.nome}`, `× ${o.qtd}`);

  titulo('FINANCEIRO DO DIA');
  linha('Vendas do sistema', fmtMoeda(fin.vendas_sistema));
  linha('Receitas manuais', fmtMoeda(fin.receita_manual));
  linha('Receita acumulada', fmtMoeda(fin.receita_total), { bold: true });
  linha('Investimento', fmtMoeda(fin.investimento_manual));
  linha('Insumos', fmtMoeda(fin.insumos_total));
  linha('Despesas', fmtMoeda(fin.despesas));
  linha('Motoboys', fmtMoeda(fin.motoboy_total));
  linha('Custo total', fmtMoeda(fin.custo_total));
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(15).fillColor(PDF_PRETO)
    .text(`LUCRO REAL: ${fmtMoeda(fin.lucro_real)}`);
  doc.font('Helvetica').fontSize(11).fillColor(PDF_PRETO)
    .text(`Custo por copo: ${fmtMoeda(fin.custo_por_copo)} · Preço médio por copo: ${fmtMoeda(fin.preco_medio_copo)} · Lucro por copo: ${fmtMoeda(fin.lucro_por_copo)}`);

  rodape();
  doc.end();
}

// ---------- PDF do relatório MENSAL (v1.7) ----------
const ROTULO_FORMA = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', pix_mp: 'Pix (MP)', cartao_mp: 'Cartão (MP)', pix_asaas: 'Pix (Asaas)', cartao_asaas: 'Cartão (Asaas)' };
function gerarPdfRelatorioMensal(rel, lojaInfo, res) {
  const doc = abrirDocRelatorio(res, `relatorio-mensal-${rel.mes}.pdf`);
  const { linha, titulo, rodape } = pecasRelatorio(doc);
  const fin = rel.financeiro;
  const nome = typeof lojaInfo === 'string' ? lojaInfo : (lojaInfo && lojaInfo.nome);
  const logo = lojaInfo && typeof lojaInfo === 'object' ? lojaInfo.logo : null;

  const [ano, mesNum] = rel.mes.split('-').map(Number);
  const mesExtenso = new Date(ano, mesNum - 1, 1).toLocaleDateString('pt-BR', { month: 'long' });
  cabecalhoRelatorio(doc, nome, logo, `Relatório mensal — ${mesExtenso}/${ano}`);

  titulo('RESUMO DO MÊS');
  linha('Pedidos concluídos', String(rel.totais.pedidos_concluidos));
  linha('Pedidos cancelados', String(rel.totais.pedidos_cancelados));
  linha('Faturamento', fmtMoeda(rel.totais.faturamento_centavos), { bold: true });
  linha('Ticket médio', fmtMoeda(rel.totais.ticket_medio_centavos));

  titulo('POR FORMA DE PAGAMENTO');
  if (!rel.por_pagamento.length) doc.font('Helvetica').fontSize(11).fillColor(PDF_PRETO).text('Nenhuma venda concluída neste mês.');
  for (const f of rel.por_pagamento) {
    linha(ROTULO_FORMA[f.forma] || f.forma, `${f.qtd} pedido(s) — ${fmtMoeda(f.total_centavos)}`);
  }

  titulo('VENDAS POR DIA');
  let y = doc.y;
  const cel = (txt, x, w, align, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(PDF_PRETO)
      .text(String(txt), x, y, { width: w, align: align || 'left', lineBreak: false });
  };
  const novaPaginaSePreciso = () => { if (y > 740) { doc.addPage(); y = 56; } };
  cel('Data', 48, 90, 'left', true);
  cel('Concluídos', 140, 80, 'right', true);
  cel('Cancelados', 228, 90, 'right', true);
  cel('Faturamento', 326, 110, 'right', true);
  cel('Ticket médio', 444, 103, 'right', true);
  y += 15;
  doc.moveTo(48, y).lineTo(547, y).strokeColor(PDF_LINHA).lineWidth(0.7).stroke();
  y += 5;
  if (!rel.dias.length) { doc.font('Helvetica').fontSize(11).fillColor(PDF_PRETO).text('Nenhum pedido neste mês.', 48, y); y += 16; }
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
  doc.moveTo(48, y).lineTo(547, y).strokeColor(PDF_LINHA).lineWidth(0.7).stroke();
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
  linha('Motoboys', fmtMoeda(fin.motoboy_total));
  linha('Custo total', fmtMoeda(fin.custo_total));
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(PDF_PRETO)
    .text(`LUCRO DAS VENDAS (OPERACIONAL): ${fmtMoeda(fin.lucro_operacional_centavos)}`);
  doc.font('Helvetica-Bold').fontSize(15).fillColor(PDF_PRETO)
    .text(`RESULTADO APÓS INVESTIMENTOS: ${fmtMoeda(fin.lucro_real)}`);
  doc.font('Helvetica').fontSize(11).fillColor(PDF_PRETO)
    .text(`Custo por copo: ${fmtMoeda(fin.custo_por_copo)} · Preço médio por copo: ${fmtMoeda(fin.preco_medio_copo)} · Lucro por copo: ${fmtMoeda(fin.lucro_por_copo)}`);

  rodape();
  doc.end();
}

module.exports = {
  TIPOS_LANCAMENTO, dataHoje, dataValida, dataBR, roundHU, mesValido, limitesDoMes,
  listarLancamentos, criarLancamento, atualizarLancamento, excluirLancamento,
  listarInsumos, criarInsumo, atualizarInsumo, excluirInsumo,
  calcular, calcularPeriodo, resumoRelatorio, relatorioMensal,
  dadosXmlMensal, gerarXmlMensal, escapeXml,
  gerarPdfRelatorio, gerarPdfRelatorioMensal, carregarLogo,
};
