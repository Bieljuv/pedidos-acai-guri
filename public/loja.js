'use strict';
/* ============================================================
   Açaí do Guri — loja do cliente (JS puro, sem build)
   API conforme CONTRATO.md · dinheiro sempre em centavos
   ============================================================ */

/* ---------- utilitários ---------- */
const $  = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const fmtBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const R$ = (centavos) => fmtBRL.format((centavos || 0) / 100);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const semAcento = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const formatarHora = (iso) => {
  if (!iso) return '';
  let s = String(iso);
  /* Datas do banco vêm em UTC sem fuso marcado — sem o 'Z' o navegador
     mostraria 3h a mais. Convertendo, sai o horário de Brasília. */
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  return isNaN(d) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
};

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

/* Corte + aviso "vamos fechar em breve" (v1.16.14): um unico ajuste em
   Loja e Aparencia (minutos antes de fechar) comanda os dois:
   - faltando de 2x a 1x os minutos para o fechamento: ao adicionar ao
     carrinho, o aviso "vamos fechar em breve" com o horario do corte;
   - dentro dos minutos finais: o pedido NAO passa — o servidor barra
     (palavra final) e a tela avisa antes de enviar; o aviso no carrinho
     vira a propria mensagem do corte.
   Uma vez por aba, para nao repetir a cada item. */
function minutosAteFechar() {
  if (!loja || !loja.horario_fecha) return null;
  const [fh, fm] = String(loja.horario_fecha).split(':').map(Number);
  if (Number.isNaN(fh)) return null;
  const agora = new Date();
  const base = new Date(agora); base.setHours(fh, fm || 0, 0, 0);
  let menor = Infinity;
  for (const d of [-86400000, 0, 86400000]) {
    const diff = (base.getTime() + d - agora.getTime()) / 60000;
    if (diff >= 0 && diff < menor) menor = diff;
  }
  return menor;
}
function horaCorte() {
  const minutos = Number(loja.aviso_fechar_minutos) || 30;
  const [fh, fm] = String(loja.horario_fecha).split(':').map(Number);
  let total = fh * 60 + (fm || 0) - minutos;
  if (total < 0) total += 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function msgCorteCliente() {
  if (!loja || !loja.horario_fecha) return '';
  if (loja.aviso_fechar_ativo === 0 || loja.aviso_fechar_ativo === false) return '';
  const minutos = Number(loja.aviso_fechar_minutos) || 30;
  const ate = minutosAteFechar();
  if (ate === null || ate > minutos) return '';
  return `Infelizmente já encerramos os pedidos de hoje — a cozinha precisa despachar as últimas entregas antes do fechamento, às ${String(loja.horario_fecha).slice(0, 5)}. Voltamos amanhã às ${String(loja.horario_abre || '13:00').slice(0, 5)}!`;
}
function avisoFecharTexto() {
  if (!loja || !loja.horario_fecha) return '';
  if (loja.aviso_fechar_ativo === 0 || loja.aviso_fechar_ativo === false) return '';
  if (sessionStorage.getItem('aviso_fechar_exibido')) return '';
  const minutos = Number(loja.aviso_fechar_minutos) || 30;
  const ate = minutosAteFechar();
  if (ate === null) return '';
  if (ate <= minutos) {
    sessionStorage.setItem('aviso_fechar_exibido', '1');
    return ' ' + msgCorteCliente();
  }
  if (ate <= minutos * 2) {
    sessionStorage.setItem('aviso_fechar_exibido', '1');
    return ` Vamos fechar em breve! Aceitamos pedidos só até às ${horaCorte()} — finalize a tempo.`;
  }
  return '';
}

/* ---------- Ícones SVG (v1.9: zero emoji na interface) ---------- */
/* Ícones (v1.9.2): sprite oficial public/icons.js (window.ic); o mapa
   traduz os nomes históricos da loja pros símbolos do sprite. */
const IC_MAPA_LOJA = {
  camera: 'camera', cartao: 'card', chat: 'whatsapp', chave: 'key',
  check: 'check', checkCirculo: 'check-circle', copiar: 'copy',
  estrela: 'star', tigela: 'bowl', moto: 'scooter',
};
function icLoja(nome, cls) {
  if (window.icSprite) return window.icSprite(IC_MAPA_LOJA[nome] || nome, cls);
  return `<svg class="ic ${cls || ''}" aria-hidden="true"></svg>`;
}

/* ---------- estado global ---------- */
let loja = null;
// Loja fechada/pausada (v1.12.1): TODOS os botões de compra ficam
// inativos — só Instagram e WhatsApp continuam ativos. O servidor já
// recusava o pedido no fim; agora a loja nem deixa montar a compra.
function comprasBloqueadas() { return !!loja && (!loja.aberta || !!loja.pausada); }
function aplicarTravaCompras() {
  const off = comprasBloqueadas();
  document.body.classList.toggle('loja-fechada', off);
  for (const id of ['barra-carrinho', 'hdr-carrinho', 'btn-ir-checkout']) {
    const el = document.getElementById(id);
    if (el) el.disabled = off;
  }
  $$('.card-produto').forEach((c) => { if (!c.classList.contains('esgotado')) c.disabled = off; });
}
let categorias = [];
let produtos = [];
const produtosPorId = new Map();
let bairros = [];
let carrinho = carregarCarrinho();
let buscaAtual = '';

function carregarCarrinho() {
  try {
    const c = JSON.parse(localStorage.getItem('guri_carrinho') || '[]');
    return Array.isArray(c) ? c : [];
  } catch { return []; }
}
function salvarCarrinho() {
  try { localStorage.setItem('guri_carrinho', JSON.stringify(carrinho)); } catch {}
  renderBarraCarrinho();
}
const subtotalCarrinho = () =>
  carrinho.reduce((s, i) => s + i.preco_unitario_centavos * i.quantidade, 0);
const qtdCarrinho = () => carrinho.reduce((s, i) => s + i.quantidade, 0);

/* ---------- Peça de novo (v1.14.0): cliente reconhecido pelo aparelho ---------- */
let ultimoPedidoCache = null;
let pdnModo = 'pedir'; // 'pedir' = remonta o carrinho; 'acompanhar' = vai ao acompanhamento
function mostrarPecaDeNovo(r) {
  ultimoPedidoCache = r;
  $('#pdn-resumo').textContent = 'Seu último pedido: ' +
    r.itens.map(i => `${i.quantidade}× ${i.nome_snapshot}`).join(', ');
  $('#btn-peca-de-novo').hidden = false;
  $('#btn-pdn-buscar').hidden = true;
  $('#pdn-form').hidden = true;
  $('#pdn-msg').hidden = true;
  $('#peca-de-novo').hidden = false;
}
async function verificarPecaDeNovo() {
  if (comprasBloqueadas()) return;
  let salvo = {};
  try { salvo = JSON.parse(localStorage.getItem('loja_cliente') || '{}'); } catch {}
  if (salvo.whatsapp) {
    try {
      const r = await getJSON('/api/public/ultimo-pedido/' + soDigitos(salvo.whatsapp));
      if (r && r.itens && r.itens.length) { mostrarPecaDeNovo(r); return; }
    } catch { /* cai pra busca manual */ }
  }
  // Sem reconhecimento pelo aparelho: oferece a busca pelo WhatsApp —
  // funciona em qualquer celular (v1.14.1, pedido do Gabriel).
  $('#peca-de-novo').hidden = false;
}
$('#btn-pdn-buscar').addEventListener('click', () => {
  pdnModo = 'pedir';
  $('#pdn-form').hidden = false;
  $('#btn-pdn-buscar').hidden = true;
  $('#pdn-fone').focus();
});
/* Acompanhar sempre visivel (v1.16.16): fechar o navegador sem querer
   nao pode custar o acompanhamento — o botao fica no cardao Peça de
   novo com a loja ABERTA (com ela fechada, o banner de fechada ja tem
   o campo). Reconhecido: vai direto; sem reconhecimento: busca pelo
   WhatsApp, igual ao Buscar meu pedido. */
$('#btn-pdn-acompanhar').addEventListener('click', () => {
  if (ultimoPedidoCache && ultimoPedidoCache.token) { irParaAcompanhamento(ultimoPedidoCache.token); return; }
  pdnModo = 'acompanhar';
  $('#pdn-form').hidden = false;
  $('#btn-pdn-buscar').hidden = true;
  $('#pdn-fone').focus();
});
/* Mascara de telefone que APAGA direito (v1.15.3): a versao antiga so
   reformatava o texto — ao apagar por cima do traco/parentese, a mascara
   devolvia o separador e o campo parecia TRAVADO (reclamacao do Gabriel).
   Aqui o cursor e controlado por DIGITO: apagar um separador apaga o
   digito vizinho, e cada toque no apagar tira exatamente um digito. */
function mascaraFoneInput(e) {
  const el = e.target;
  const bruto = el.value;
  const cursor = el.selectionStart || 0;
  const antesDoCursor = soDigitos(bruto.slice(0, cursor)).length;
  let digitos = soDigitos(bruto).slice(0, 11);
  let alvo = antesDoCursor;
  const anterior = Number(el.dataset.digitos || 0);
  if ((e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') && digitos.length === anterior && digitos.length > 0) {
    const idx = e.inputType === 'deleteContentBackward' ? antesDoCursor - 1 : antesDoCursor;
    if (idx >= 0 && idx < digitos.length) {
      digitos = digitos.slice(0, idx) + digitos.slice(idx + 1);
      alvo = idx;
    }
  }
  el.dataset.digitos = digitos.length;
  const novo = mascararFone(digitos);
  el.value = novo;
  let pos = 0, cont = 0;
  while (pos < novo.length && cont < alvo) { if (/\d/.test(novo[pos])) cont++; pos++; }
  try { el.setSelectionRange(pos, pos); } catch {}
}
$('#pdn-fone').addEventListener('input', mascaraFoneInput);
$('#pdn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const digitos = soDigitos($('#pdn-fone').value);
  const msg = $('#pdn-msg');
  if (digitos.length < 10) { msg.textContent = 'Digite seu WhatsApp com DDD.'; msg.hidden = false; return; }
  msg.hidden = true;
  try {
    const r = await getJSON('/api/public/ultimo-pedido/' + digitos);
    if (!r || !r.itens || !r.itens.length) {
      msg.textContent = 'Não achei pedido nesse número por aqui. Confere o número?';
      msg.hidden = false;
      return;
    }
    // Guarda o número neste aparelho: das próximas vezes reconhece sozinho.
    let salvo = {};
    try { salvo = JSON.parse(localStorage.getItem('loja_cliente') || '{}'); } catch {}
    salvo.whatsapp = digitos;
    try { localStorage.setItem('loja_cliente', JSON.stringify(salvo)); } catch {}
    if (pdnModo === 'acompanhar') {
      if (r.token) { irParaAcompanhamento(r.token); return; }
      msg.textContent = 'Não achei pedido nesse número por aqui. Confere o número?';
      msg.hidden = false;
      return;
    }
    mostrarPecaDeNovo(r);
  } catch {
    msg.textContent = 'Não consegui buscar agora. Tenta de novo em instantes.';
    msg.hidden = false;
  }
});
$('#btn-peca-de-novo').addEventListener('click', () => {
  if (!ultimoPedidoCache) return;
  let adicionados = 0, pulados = 0;
  for (const it of ultimoPedidoCache.itens) {
    const produto = produtosPorId.get(it.produto_id);
    if (!produto || produto.esgotado) { pulados++; continue; }
    const ids = [];
    for (const op of (it.opcoes || [])) {
      const g = (produto.grupos || []).find(g => g.nome === op.grupo_nome);
      const o = g && (g.opcoes || []).find(o => o.nome === op.opcao_nome && !o.esgotada);
      if (o) ids.push(o.id);
    }
    const faltaObrigatorio = (produto.grupos || []).some(g =>
      (g.obrigatorio || (g.minimo || 0) > 0) && !ids.some(id => (g.opcoes || []).some(o => o.id === id)));
    if (faltaObrigatorio) { pulados++; continue; }
    const sel = new Set(ids);
    const item = {
      produto_id: produto.id, nome: produto.nome, foto_url: produto.foto_url || '', tipo: produto.tipo,
      quantidade: it.quantidade, observacao: it.observacao || '', opcoes: ids,
      resumoLinhas: resumoDoItem(produto, sel), preco_unitario_centavos: calcularUnitario(produto, sel),
    };
    const igual = carrinho.findIndex(i =>
      i.produto_id === item.produto_id && i.observacao === item.observacao &&
      JSON.stringify(i.opcoes.slice().sort()) === JSON.stringify(item.opcoes.slice().sort()));
    if (igual >= 0) carrinho[igual].quantidade += item.quantidade;
    else carrinho.push(item);
    adicionados++;
  }
  if (!adicionados) { toast('Os itens do último pedido não estão mais disponíveis.'); return; }
  salvarCarrinho();
  abrirCarrinho();
  toast((pulados ? 'Pedido montado — alguns itens não estão mais no cardápio e ficaram de fora.' : 'Seu pedido de sempre está no carrinho!') + avisoFecharTexto());
});

/* ---------- cabeçalho: transição de cor dirigida pela rolagem ---------- */
const hdr = $('#hdr');
const reduzMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const PARADAS_COR = [[31, 4, 33], [70, 5, 69], [126, 4, 125]]; // #1F0421 → #460545 → #7E047D
function corCabecalho(t) {
  let a, b, lt;
  if (t < 0.5) { a = PARADAS_COR[0]; b = PARADAS_COR[1]; lt = t * 2; }
  else { a = PARADAS_COR[1]; b = PARADAS_COR[2]; lt = (t - 0.5) * 2; }
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * lt));
  const alpha = Math.min(1, t * 2.4); // transparente no topo → sólido ao fixar
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}
let rolagemPendente = false;
function atualizarCabecalho() {
  /* Cabecalho solido no acompanhamento (v1.16.19 — print do Gabriel):
     no tema claro a pagina de acompanhamento nao tem hero escuro atras
     — com o cabecalho transparente do topo, o nome branco e o botao
     "Meu pedido" sumiam no fundo claro. No acompanhamento o fundo e
     sempre solido, nos dois temas. */
  if (document.body.classList.contains('hdr-solido')) {
    hdr.style.setProperty('--hdr-bg', 'rgb(31,4,33)');
    hdr.style.setProperty('--accop', '1');
    hdr.classList.add('compacto');
    rolagemPendente = false;
    return;
  }
  const y = window.scrollY || 0;
  let t = Math.min(1, y / 240);
  if (reduzMotion) t = y > 40 ? 1 : 0; // sem interpolação: troca direta ao fixar
  hdr.style.setProperty('--hdr-bg', corCabecalho(t));
  hdr.style.setProperty('--accop', t >= 1 ? '1' : String((t * 0.7).toFixed(2)));
  hdr.classList.toggle('compacto', t >= 1);
  rolagemPendente = false;
}
window.addEventListener('scroll', () => {
  if (!rolagemPendente) { rolagemPendente = true; requestAnimationFrame(atualizarCabecalho); }
}, { passive: true });

/* ---------- overlays ---------- */
function abrirOverlay(id) { $('#overlay-' + id).hidden = false; document.body.style.overflow = 'hidden'; }
function fecharOverlay(id) {
  $('#overlay-' + id).hidden = true;
  if ($$('.overlay:not([hidden])').length === 0) document.body.style.overflow = '';
}
$$('.overlay').forEach((ov) => {
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.hidden = true, document.body.style.overflow = ''; });
});
$$('[data-fechar]').forEach((b) => b.addEventListener('click', () => fecharOverlay(b.dataset.fechar)));

/* ---------- cálculo de preço (espelha a regra do servidor) ---------- */
function calcularUnitario(produto, selecionadas) {
  let total = produto.preco_base_centavos || 0;
  for (const g of produto.grupos || []) {
    const ops = (g.opcoes || []).filter((o) => selecionadas.has(o.id));
    total += ops.reduce((s, o) => s + (o.preco_adicional_centavos || 0), 0);
    if (g.tipo_escolha === 'multipla' && g.excedente_vira_pago && g.maximo != null) {
      total += Math.max(0, ops.length - g.maximo) * (g.preco_excedente_centavos || 0);
    }
  }
  return total;
}
function precoMinimo(produto) {
  if (produto.tipo !== 'montavel') return produto.preco_base_centavos || 0;
  let t = produto.preco_base_centavos || 0;
  for (const g of produto.grupos || []) {
    const disp = (g.opcoes || []).filter((o) => !o.esgotada)
      .map((o) => o.preco_adicional_centavos || 0).sort((a, b) => a - b);
    if (!disp.length) continue;
    if (g.tipo_escolha === 'unica') { if (g.obrigatorio) t += disp[0]; }
    else {
      const min = g.obrigatorio ? Math.max(g.minimo || 0, 1) : 0;
      for (let i = 0; i < Math.min(min, disp.length); i++) t += disp[i];
    }
  }
  return t;
}
function validarGrupo(g, qtdSel) {
  if (g.tipo_escolha === 'unica') {
    if (g.obrigatorio && qtdSel < 1) return 'Escolha uma opção para continuar.';
    return null;
  }
  if (qtdSel === 0) {
    if (g.obrigatorio) return `Escolha pelo menos ${Math.max(g.minimo || 0, 1)} opção(ões).`;
    return null;
  }
  if ((g.minimo || 0) > 0 && qtdSel < g.minimo) return `Escolha pelo menos ${g.minimo} opções.`;
  return null;
}
function dicaGrupo(g) {
  const partes = [];
  if (g.tipo_escolha === 'unica') partes.push(g.obrigatorio ? 'Escolha 1 (obrigatório)' : 'Escolha 1 (opcional)');
  else {
    if (g.maximo != null) partes.push(`Escolha até ${g.maximo}`);
    if ((g.minimo || 0) > 0) partes.push(`mínimo ${g.minimo}`);
    if (g.obrigatorio && (g.minimo || 0) === 0) partes.push('obrigatório');
    if (g.excedente_vira_pago && g.maximo != null && (g.preco_excedente_centavos || 0) > 0)
      partes.push(`extras por +${R$(g.preco_excedente_centavos)} cada`);
    if (!partes.length) partes.push('Escolha quantos quiser');
  }
  return partes.join(' · ');
}
function resumoDoItem(produto, selecionadas) {
  const linhas = [];
  for (const g of produto.grupos || []) {
    const nomes = (g.opcoes || []).filter((o) => selecionadas.has(o.id)).map((o) => o.nome);
    if (nomes.length) linhas.push(`${g.nome}: ${nomes.join(', ')}`);
  }
  return linhas;
}

/* ---------- carregamento inicial ---------- */
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
/* Sorteio divulgado (v1.16.9): quando o dono cria um sorteio, ele e'
   anunciado pro cliente em dois momentos — um aviso estilo push que
   desliza na vitrine (da' pra fechar; nao volta pro mesmo sorteio) e
   um aviso na finalizacao da compra. O estado fica guardado pra
   finalizacao nao precisar consultar de novo. */
let sorteioAtivoLoja = null;
async function consultarSorteioAtivo() {
  try {
    const r = await getJSON('/api/public/sorteio-ativo');
    if (!r || !r.ativo) { sorteioAtivoLoja = null; return; }
    sorteioAtivoLoja = r;
    mostrarPushSorteio(r);
    // Se a finalizacao ja estiver aberta, o aviso entra nela tambem.
    const ckSorteio = $('#ck-sorteio');
    if (ckSorteio) {
      ckSorteio.innerHTML = `${icLoja('trophy')} <strong>Sorteio rolando:</strong> ${esc(r.titulo)} — prêmio: <strong>${esc(r.premio)}</strong>. Finalizando este pedido, você participa automaticamente!`;
      ckSorteio.hidden = false;
    }
  } catch { /* sorteio nunca atrapalha a compra */ }
}
function mostrarPushSorteio(s) {
  let fechado = false;
  try { fechado = localStorage.getItem('sorteio_fechado_' + s.id) === '1'; } catch { /* sem storage */ }
  if (fechado || document.querySelector('.push-sorteio')) return;
  const el = document.createElement('div');
  el.className = 'push-sorteio';
  el.innerHTML = `
    <div class="push-sorteio-ic">${icLoja('trophy')}</div>
    <div class="push-sorteio-txt">
      <strong>${esc(s.titulo)}</strong>
      <span>Concorra a: <strong>${esc(s.premio)}</strong>. Cada compra entregue vale 1 chance — pedindo por aqui, você já está participando!</span>
    </div>
    <button type="button" class="push-sorteio-x" aria-label="Fechar aviso do sorteio">${icLoja('x')}</button>`;
  document.body.appendChild(el);
  const esconder = () => { el.classList.remove('visivel'); setTimeout(() => el.remove(), 350); };
  el.querySelector('.push-sorteio-x').addEventListener('click', () => {
    try { localStorage.setItem('sorteio_fechado_' + s.id, '1'); } catch { /* ok */ }
    esconder();
  });
  setTimeout(() => el.classList.add('visivel'), 700);
  // Some sozinho depois de um tempo, mas isso NAO conta como "fechado":
  // no proximo acesso ele aparece de novo (so o X dispensa de vez).
  setTimeout(() => { if (document.body.contains(el)) esconder(); }, 14000);
}

async function iniciar() {
  atualizarCabecalho();
  try {
    const [lj, card, br] = await Promise.all([
      getJSON('/api/public/loja'),
      getJSON('/api/public/cardapio'),
      getJSON('/api/public/bairros'),
    ]);
    loja = lj;
    categorias = (card.categorias || []).slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
    produtos = (card.produtos || []).slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
    produtos.forEach((p) => produtosPorId.set(p.id, p));
    bairros = (br || []).filter((b) => b.ativo !== false);
    renderLoja();
    renderCardapio();
    renderBarraCarrinho();
    verificarPecaDeNovo();
    consultarSorteioAtivo();
  } catch (e) {
    $('#hero-status').textContent = 'Não foi possível carregar a loja agora. Verifique sua conexão e recarregue a página.';
    $('#hero-status').className = 'hero-status fechada';
  }
  roteador();
}

// Icone da aba do navegador (v1.13.5): a logo da loja desenhada sobre um
// quadrado da COR dela. Logo branca/transparente some na abinha do navegador;
// com o fundo da marca, aparece. Se algo falhar, usa a logo pura.
function faviconDaLoja(url, cor) {
  if (!url) return;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const x = c.getContext('2d');
      const fundo = (p) => { x.beginPath(); if (x.roundRect) x.roundRect(0, 0, 64, 64, 14); else x.rect(0, 0, 64, 64); };
      x.fillStyle = cor || '#7E047D'; fundo(); x.fill();
      x.save(); fundo(); x.clip();
      const esc = Math.max(56 / img.width, 56 / img.height);
      const w = img.width * esc, h = img.height * esc;
      x.drawImage(img, 4 + (56 - w) / 2, 4 + (56 - h) / 2, w, h);
      x.restore();
      let link = document.querySelector('link[rel="icon"]');
      if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
      link.type = 'image/png'; link.href = c.toDataURL('image/png');
    } catch { const link = document.querySelector('link[rel="icon"]'); if (link) link.href = url; }
  };
  img.src = url;
}

function renderLoja() {
  document.title = `${loja.nome} — Peça online`;
  $('#hdr-nome').textContent = loja.nome;
  $('#hero-nome').textContent = loja.nome;
  if (loja.logo_url) {
    const gl = $('#hero-logo'); gl.src = loja.logo_url; gl.hidden = false;
    faviconDaLoja(loja.logo_url, loja.cor_primaria);
  }
  // Capa (v1.15.1): fora do if da logo (loja com capa e sem logo não exibia
  // a capa) e com a classe do FOCO que o dono escolheu pro celular.
  const capa = $('#hero-capa');
  const heroEl = document.querySelector('.hero');
  capa.classList.remove('foco-esquerda', 'foco-direita');
  if (loja.capa_foco === 'esquerda' || loja.capa_foco === 'direita') capa.classList.add('foco-' + loja.capa_foco);
  if (loja.capa_url) { capa.src = loja.capa_url; heroEl.classList.add('com-capa'); }
  else { capa.removeAttribute('src'); heroEl.classList.remove('com-capa'); }
  const aberta = !!loja.aberta && !loja.pausada;
  const hs = $('#hdr-status');
  hs.textContent = loja.pausada ? 'Pausada' : (aberta ? 'Aberta' : 'Fechada');
  hs.className = 'hstatus ' + (aberta ? 'aberta' : 'fechada');
  const hero = $('#hero-status');
  const dotStatus = loja.pausada ? 'dot-amarelo' : (aberta ? 'dot-verde' : 'dot-vermelho');
  const txtStatus = loja.pausada ? 'Pausada no momento' : (aberta ? 'Aberta agora' : 'Fechada no momento');
  hero.innerHTML = `<span class="dot ${dotStatus}"></span> ${txtStatus}`;
  hero.className = 'hero-status ' + (aberta ? 'aberta' : 'fechada');

  const infos = [];
  if (loja.tempo_entrega_min) infos.push(`Entrega em ~${loja.tempo_entrega_min} min`);
  else if (loja.tempo_preparo_min) infos.push(`Preparo em ~${loja.tempo_preparo_min} min`);
  if (loja.taxa_unica_centavos != null) infos.push(`Entrega ${loja.taxa_unica_centavos === 0 ? 'grátis' : R$(loja.taxa_unica_centavos)}`);
  if (loja.pedido_minimo_centavos > 0) infos.push(`Pedido mínimo ${R$(loja.pedido_minimo_centavos)}`);
  $('#hero-info').textContent = infos.join('  •  ');

  if (loja.instagram) {
    const a = $('#hero-insta');
    const user = String(loja.instagram).replace(/^@/, '');
    a.href = 'https://www.instagram.com/' + user + '/';
    a.innerHTML = icLoja('instagram') + ' @' + esc(user);
    a.hidden = false;
  }
  if (loja.whatsapp) {
    const a = $('#hero-zap');
    a.href = 'https://wa.me/' + soDigitos(loja.whatsapp);
    a.hidden = false;
  }
  /* Rodape (v1.16.8 — pedido do Gabriel): no rodape vai so a CIDADE - UF
     (a ultima parte do endereco cadastrado), nao o endereco completo —
     o endereco inteiro segue guardado na ficha da loja. */
  if (loja.endereco_texto) {
    const partes = String(loja.endereco_texto).split(',').map((s) => s.trim()).filter(Boolean);
    $('#rodape-endereco').textContent = partes.length > 1 ? partes[partes.length - 1] : loja.endereco_texto;
  }
  // v1.9.15/16: nome fantasia + CNPJ/CPF no rodapé (quando a loja cadastrou
  // o documento; razão social não entra — decisão do Gabriel).
  if (loja.documento) {
    const d = String(loja.documento || '').replace(/\D/g, '');
    let docFmt = d;
    if (d.length === 14) docFmt = d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    else if (d.length === 11) docFmt = d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    const rotulo = d.length === 11 ? 'CPF' : 'CNPJ';
    if (d) $('#rodape-documento').textContent = `${loja.nome} · ${rotulo} ${docFmt}`;
  }

  const banner = $('#banner-fechada');
  if (!aberta) {
    // Acompanhar com a loja fechada (v1.16.14): o cliente que pediu
    // antes de fechar perdia o acompanhamento se fechasse a aba — a
    // home fechada nao tinha nenhum caminho ate o pedido. O botao pede
    // o WhatsApp e leva direto ao acompanhamento do ultimo pedido.
    const msg = loja.mensagem_status ||
      (loja.pausada
        ? 'A loja está pausada e não está recebendo pedidos no momento. Volte em instantes!'
        : 'A loja está fechada e não está recebendo pedidos no momento. Você pode olhar o cardápio; volte no horário de funcionamento!');
    banner.innerHTML = `<span>${esc(msg)}</span>
      <div class="acomp-fechada">
        <label for="acomp-fone">Já fez um pedido? Acompanhe aqui mesmo:</label>
        <span class="acomp-fechada-row">
          <input id="acomp-fone" type="tel" inputmode="numeric" placeholder="Seu WhatsApp com DDD" maxlength="15">
          <button type="button" class="btn-primario" id="btn-acomp-fechada">Acompanhar</button>
        </span>
      </div>`;
    banner.hidden = false;
    const irAcomp = async () => {
      // Numero com DDD tem 11 digitos; o servidor normaliza com 55.
      let dig = soDigitos($('#acomp-fone').value);
      if (dig && !dig.startsWith('55')) dig = '55' + dig;
      if (dig.length < 12) { toast('Informe seu WhatsApp com DDD.'); return; }
      try {
        const r = await getJSON('/api/public/ultimo-pedido/' + dig);
        if (r && r.token) irParaAcompanhamento(r.token);
        else toast('Não encontramos pedido para este WhatsApp.');
      } catch { toast('Não foi possível buscar agora. Tente de novo.'); }
    };
    $('#btn-acomp-fechada').addEventListener('click', irAcomp);
    $('#acomp-fone').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); irAcomp(); } });
  } else banner.hidden = true;
  aplicarTravaCompras();
}

/* Nome do topo surge so ao passar do hero (v1.13.2). */
(function observarHero() {
  const hero = document.querySelector('.hero');
  if (!hero || !('IntersectionObserver' in window)) { document.body.classList.add('rolou'); return; }
  const obs = new IntersectionObserver((es) => {
    for (const e of es) document.body.classList.toggle('rolou', !e.isIntersecting);
  }, { rootMargin: '-64px 0px 0px 0px' });
  obs.observe(hero);
})();

/* ---------- cardápio ---------- */
function produtosDaCategoria(catId) {
  return produtos.filter((p) => p.categoria_id === catId);
}
function renderChips() {
  const nav = $('#chips');
  nav.innerHTML = '';
  for (const c of categorias) {
    if (!produtosDaCategoria(c.id).length) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = c.nome;
    b.dataset.alvo = 'secao-' + c.id;
    b.addEventListener('click', () => {
      const alvo = document.getElementById('secao-' + c.id);
      if (alvo) alvo.scrollIntoView({ behavior: reduzMotion ? 'auto' : 'smooth' });
      $$('.chip', nav).forEach((x) => x.classList.toggle('ativo', x === b));
    });
    nav.appendChild(b);
  }
}
function cardProduto(p) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card-produto' + (p.esgotado ? ' esgotado' : '');
  card.disabled = !!p.esgotado || comprasBloqueadas();
  const min = precoMinimo(p);
  const precoHTML = p.tipo === 'montavel'
    ? `<span class="apartir">a partir de</span> ${R$(min)}`
    : R$(min);
  const foto = p.foto_url
    ? `<img class="cp-foto" src="${esc(p.foto_url)}" alt="" loading="lazy" decoding="async">`
    : `<div class="cp-foto-vazia" aria-hidden="true">${icLoja('tigela')}</div>`;
  const selos = [
    p.destaque ? `<span class="selo selo-destaque">${icLoja('estrela')} Mais pedido</span>` : '',
    p.esgotado ? '<span class="selo selo-esgotado">Esgotado</span>' : '',
  ].join('');
  card.innerHTML = `
    <div class="cp-textos">
      ${selos ? `<div class="cp-selos">${selos}</div>` : ''}
      <span class="cp-nome">${esc(p.nome)}</span>
      ${p.descricao ? `<span class="cp-desc">${esc(p.descricao)}</span>` : ''}
      <span class="cp-preco">${precoHTML}</span>
    </div>${foto}`;
  card.addEventListener('click', () => abrirMontador(p, null));
  return card;
}
function renderCardapio() {
  renderChips();
  const cont = $('#cardapio');
  cont.innerHTML = '';
  const termo = semAcento(buscaAtual.trim());
  let algum = false;
  for (const c of categorias) {
    let lista = produtosDaCategoria(c.id);
    if (termo) lista = lista.filter((p) => semAcento(p.nome).includes(termo) || semAcento(p.descricao || '').includes(termo));
    if (!lista.length) continue;
    algum = true;
    const sec = document.createElement('section');
    sec.className = 'secao';
    sec.id = 'secao-' + c.id;
    const h = document.createElement('h2');
    h.className = 'secao-titulo';
    h.textContent = c.nome;
    sec.appendChild(h);
    lista.forEach((p) => sec.appendChild(cardProduto(p)));
    cont.appendChild(sec);
  }
  $('#sem-resultado').hidden = algum;
  observarSecoes();
}
let observadorSecoes = null;
function observarSecoes() {
  if (observadorSecoes) observadorSecoes.disconnect();
  observadorSecoes = new IntersectionObserver((entradas) => {
    for (const e of entradas) {
      if (e.isIntersecting) {
        $$('.chip').forEach((ch) => ch.classList.toggle('ativo', ch.dataset.alvo === e.target.id));
      }
    }
  }, { rootMargin: '-30% 0px -60% 0px' });
  $$('.secao').forEach((s) => observadorSecoes.observe(s));
}
$('#busca').addEventListener('input', (e) => { buscaAtual = e.target.value; renderCardapio(); });

/* ============================================================
   MONTADOR
   ============================================================ */
let mont = null; // { produto, selecionadas:Set, qtd, editandoIdx }

function abrirMontador(produto, itemCarrinho) {
  mont = {
    produto,
    selecionadas: new Set(itemCarrinho ? itemCarrinho.opcoes : []),
    qtd: itemCarrinho ? itemCarrinho.quantidade : 1,
    editandoIdx: itemCarrinho ? carrinho.indexOf(itemCarrinho) : -1,
  };
  $('#montador-titulo').textContent = produto.nome;
  const foto = $('#montador-foto');
  if (produto.foto_url) { foto.src = produto.foto_url; foto.hidden = false; } else foto.hidden = true;
  $('#montador-desc').textContent = produto.descricao || '';
  $('#montador-obs').value = itemCarrinho ? (itemCarrinho.observacao || '') : '';
  renderGruposMontador();
  atualizarRodapeMontador();
  abrirOverlay('montador');
}
function grupoDoMontador(gid) {
  return (mont.produto.grupos || []).find((g) => g.id === gid);
}
function qtdSelecionadas(gid) {
  const g = grupoDoMontador(gid);
  return (g.opcoes || []).filter((o) => mont.selecionadas.has(o.id)).length;
}
function renderGruposMontador() {
  const cont = $('#montador-grupos');
  cont.innerHTML = '';
  const grupos = (mont.produto.grupos || []).slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
  for (const g of grupos) {
    const div = document.createElement('div');
    div.className = 'grupo';
    div.id = 'grupo-' + g.id;
    const contSel = qtdSelecionadas(g.id);
    const contador = g.tipo_escolha === 'multipla' && g.maximo != null
      ? `${contSel}/${g.maximo}` : (contSel ? `${contSel} selecionado(s)` : '');
    div.innerHTML = `
      <div class="grupo-topo">
        <span class="grupo-nome">${esc(g.nome)}</span>
        <span class="grupo-contador">${esc(contador)}</span>
      </div>
      <p class="grupo-dica">${esc(dicaGrupo(g))}</p>
      <p class="grupo-erro" hidden></p>`;
    const ops = (g.opcoes || []).slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
    const noLimite = g.tipo_escolha === 'multipla' && !g.excedente_vira_pago &&
      g.maximo != null && contSel >= g.maximo;
    const cotaGrupo = (g.tipo_escolha === 'multipla' && g.excedente_vira_pago && g.maximo != null)
      ? g.maximo : null;
    const idsGrupo = new Set(ops.map((x) => x.id));
    const marcadosGrupo = [...mont.selecionadas].filter((id) => idsGrupo.has(id));
    for (const o of ops) {
      const sel = mont.selecionadas.has(o.id);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opcao' + (g.tipo_escolha === 'multipla' ? ' multipla' : '') +
        (sel ? ' selecionada' : '') + (o.esgotada ? ' esgotada' : '') +
        (!sel && noLimite ? ' bloqueada' : '');
      b.disabled = !!o.esgotada;
      /* v1.9.11: rotulo segue a COTA do grupo — os primeiros `maximo` marcados
         sao "incluso"; da cota em diante, "+ R$ X extra" (espelha o calculo de
         calcularUnitario). A ordem e a de marcacao (o Set guarda a insercao);
         opcao ainda nao marcada ja mostra "extra" se a cota estiver cheia. */
      let preco;
      if ((o.preco_adicional_centavos || 0) > 0) {
        preco = `<span class="op-preco">+ ${R$(o.preco_adicional_centavos)}</span>`;
      } else if (cotaGrupo != null) {
        const ehExtra = sel
          ? marcadosGrupo.indexOf(o.id) >= cotaGrupo
          : marcadosGrupo.length >= cotaGrupo;
        preco = ehExtra
          ? `<span class="op-preco extra">+ ${R$(g.preco_excedente_centavos || 0)} extra</span>`
          : `<span class="op-preco gratis">incluso</span>`;
      } else {
        preco = `<span class="op-preco gratis">incluso</span>`;
      }
      b.innerHTML = `<span class="op-marcador">${sel ? icLoja('check') : ''}</span>
        <span class="op-nome">${esc(o.nome)}${o.esgotada ? ' (esgotado)' : ''}</span>${preco}`;
      b.addEventListener('click', () => alternarOpcao(g, o));
      div.appendChild(b);
    }
    cont.appendChild(div);
  }
}
function alternarOpcao(g, o) {
  const sel = mont.selecionadas;
  if (g.tipo_escolha === 'unica') {
    const ja = sel.has(o.id);
    (g.opcoes || []).forEach((x) => sel.delete(x.id));
    if (!ja || g.obrigatorio) sel.add(o.id); // opcional permite desmarcar
  } else {
    if (sel.has(o.id)) sel.delete(o.id);
    else {
      if (!g.excedente_vira_pago && g.maximo != null && qtdSelecionadas(g.id) >= g.maximo) {
        toast(`Máximo de ${g.maximo} neste grupo.`);
        return;
      }
      sel.add(o.id);
    }
  }
  const divG = $('#grupo-' + g.id);
  if (divG) divG.classList.remove('invalido');
  renderGruposMontador();
  atualizarRodapeMontador();
}
function atualizarRodapeMontador() {
  const btnAdd = $('#montador-adicionar');
  if (btnAdd) btnAdd.disabled = comprasBloqueadas();
  if (!mont) return;
  $('#montador-qtd').textContent = mont.qtd;
  const unit = calcularUnitario(mont.produto, mont.selecionadas);
  // v1.16.32: com obrigatório pendente, o botão diz O QUE falta em vez
  // de "Adicionar • R$ 0,00" — o toque continua validando (aviso + rola
  // até o grupo), mas o botão já não convida ao toque à toa.
  const pendente = (mont.produto.grupos || []).find((g) => validarGrupo(g, qtdSelecionadas(g.id)));
  $('#montador-adicionar').textContent = pendente
    ? `Escolha: ${pendente.nome}`
    : `${mont.editandoIdx >= 0 ? 'Atualizar' : 'Adicionar'} • ${R$(unit * mont.qtd)}`;
}
$('#montador-menos').addEventListener('click', () => { if (mont && mont.qtd > 1) { mont.qtd--; atualizarRodapeMontador(); } });
$('#montador-mais').addEventListener('click', () => { if (mont && mont.qtd < 30) { mont.qtd++; atualizarRodapeMontador(); } });
$('#montador-adicionar').addEventListener('click', () => {
  if (!mont || comprasBloqueadas()) return;
  const { produto, selecionadas } = mont;
  let primeiroInvalido = null;
  for (const g of produto.grupos || []) {
    const erro = validarGrupo(g, qtdSelecionadas(g.id));
    const divG = $('#grupo-' + g.id);
    if (divG) {
      divG.classList.toggle('invalido', !!erro);
      const elErro = $('.grupo-erro', divG);
      if (elErro) { elErro.textContent = erro || ''; elErro.hidden = !erro; }
    }
    if (erro && !primeiroInvalido) primeiroInvalido = divG;
  }
  if (primeiroInvalido) {
    primeiroInvalido.scrollIntoView({ behavior: reduzMotion ? 'auto' : 'smooth', block: 'center' });
    toast('Falta escolher uma opção obrigatória.');
    return;
  }
  const opcoesIds = (produto.grupos || [])
    .flatMap((g) => (g.opcoes || []).filter((o) => selecionadas.has(o.id)).map((o) => o.id));
  const item = {
    produto_id: produto.id,
    nome: produto.nome,
    foto_url: produto.foto_url || '',
    tipo: produto.tipo,
    quantidade: mont.qtd,
    observacao: $('#montador-obs').value.trim(),
    opcoes: opcoesIds,
    resumoLinhas: resumoDoItem(produto, selecionadas),
    preco_unitario_centavos: calcularUnitario(produto, selecionadas),
  };
  if (mont.editandoIdx >= 0) carrinho[mont.editandoIdx] = item;
  else {
    const igual = carrinho.findIndex((i) =>
      i.produto_id === item.produto_id && i.observacao === item.observacao &&
      JSON.stringify(i.opcoes.slice().sort()) === JSON.stringify(item.opcoes.slice().sort()));
    if (igual >= 0) carrinho[igual].quantidade += item.quantidade;
    else carrinho.push(item);
  }
  mont = null;
  salvarCarrinho();
  fecharOverlay('montador');
  renderCarrinho();
  toast('Adicionado ao pedido.' + avisoFecharTexto());
});

/* ============================================================
   CARRINHO
   ============================================================ */
function renderBarraCarrinho() {
  const barra = $('#barra-carrinho');
  const q = qtdCarrinho();
  barra.hidden = q === 0 || !$('#view-pedido').hidden;
  $('#barra-info').textContent = q > 0 ? `${q} ${q === 1 ? 'item' : 'itens'} • ${R$(subtotalCarrinho())}` : '';
  const badge = $('#hdr-badge');
  badge.hidden = q === 0;
  badge.textContent = q;
}
function abrirCarrinho() { if (comprasBloqueadas()) return; renderCarrinho(); abrirOverlay('carrinho'); }
function renderCarrinho() {
  const cont = $('#carrinho-itens');
  cont.innerHTML = '';
  if (!carrinho.length) {
    cont.innerHTML = '<p class="carrinho-vazio">Seu pedido está vazio.<br>Escolha algo gostoso no cardápio!</p>';
  }
  carrinho.forEach((item, idx) => {
    const div = document.createElement('div');
    div.className = 'item-carrinho';
    const linhas = (item.resumoLinhas || []).map(esc).join('\n');
    div.innerHTML = `
      <div class="ic-topo">
        <span class="ic-nome">${item.quantidade}× ${esc(item.nome)}</span>
        <span class="ic-preco">${R$(item.preco_unitario_centavos * item.quantidade)}</span>
      </div>
      ${linhas ? `<p class="ic-opcoes">${linhas}</p>` : ''}
      ${item.observacao ? `<p class="ic-obs">“${esc(item.observacao)}”</p>` : ''}
      <div class="ic-acoes">
        <div class="qtd-controle">
          <button type="button" data-acao="menos" aria-label="Diminuir">−</button>
          <span>${item.quantidade}</span>
          <button type="button" data-acao="mais" aria-label="Aumentar">+</button>
        </div>
        <button type="button" class="btn-texto" data-acao="editar">Editar</button>
        <button type="button" class="btn-texto perigo" data-acao="remover">Remover</button>
      </div>`;
    div.addEventListener('click', (e) => {
      const acao = e.target.closest('[data-acao]')?.dataset.acao;
      if (!acao) return;
      if (acao === 'menos') { item.quantidade--; if (item.quantidade <= 0) carrinho.splice(idx, 1); }
      if (acao === 'mais') item.quantidade = Math.min(30, item.quantidade + 1);
      if (acao === 'remover') carrinho.splice(idx, 1);
      if (acao === 'editar') {
        const p = produtosPorId.get(item.produto_id);
        if (p) { fecharOverlay('carrinho'); abrirMontador(p, item); return; }
        toast('Este item não está mais no cardápio.');
        return;
      }
      salvarCarrinho();
      renderCarrinho();
    });
    cont.appendChild(div);
  });
  $('#carrinho-subtotal').textContent = R$(subtotalCarrinho());
  const obsTaxa = $('#carrinho-taxa-obs');
  if (obsTaxa) {
    const tc = taxaConhecidaCarrinho();
    obsTaxa.textContent = tc === null
      ? 'A taxa de entrega é calculada na finalização.'
      : `Taxa de entrega${tc.salvo ? ' (seu bairro salvo)' : ''}: ${tc.valor === 0 ? 'Grátis' : R$(tc.valor)}`;
  }
  $('#btn-ir-checkout').disabled = !carrinho.length;
}
$('#barra-carrinho').addEventListener('click', abrirCarrinho);
$('#hdr-carrinho').addEventListener('click', abrirCarrinho);
$('#btn-ir-checkout').addEventListener('click', () => { fecharOverlay('carrinho'); abrirCheckout(); });

/* ============================================================
   CHECKOUT
   ============================================================ */
const METODOS_PADRAO = [
  { codigo: 'pix', rotulo: 'Pix (na entrega/retirada)', online: false },
  { codigo: 'cartao', rotulo: 'Cartão (na entrega/retirada)', online: false },
  { codigo: 'dinheiro', rotulo: 'Dinheiro', online: false },
];
const ROTULOS_PAG = {
  pix: 'Pix (na entrega/retirada)', cartao: 'Cartão (na entrega/retirada)', dinheiro: 'Dinheiro',
  pix_mp: 'Pix online — Mercado Pago', cartao_mp: 'Cartão online — Mercado Pago',
  pix_asaas: 'Pix online — Asaas', cartao_asaas: 'Cartão online — Asaas',
};
const ONLINE_SET = new Set(['pix_mp', 'cartao_mp', 'pix_asaas', 'cartao_asaas']);
let tipoRecebimento = 'entrega';
let pagamentoSel = null;
let ultimoPagamento = null; // pagamento devolvido pelo POST (online)

function mascararFone(v) {
  const d = soDigitos(v).slice(0, 11);
  if (d.length > 6) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length > 2) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length > 0) return `(${d}`;
  return '';
}
$('#ck-whats').addEventListener('input', (e) => {
  mascaraFoneInput(e);
  /* Trocou o numero no meio do checkout: o premio consultado era de
     OUTRO cliente — limpa na hora pra nao mostrar desconto errado. */
  if (fidelidadeCheckout && fidelidadeCheckout._digitos !== soDigitos(e.target.value)) {
    fidelidadeCheckout = null;
    $('#ck-fidelidade').hidden = true;
    atualizarResumoCheckout();
  }
});
/* Fidelidade: o estado consultado do cliente (com o digito consultado).
   v1.16.4 (pedido do Gabriel): o desconto do premio entra JA no resumo
   da finalizacao — taxa zerada e total menor ANTES de confirmar, igual
   ao que o servidor aplica ao criar o pedido (a previa vem da consulta
   publica; o servidor revalida na criacao). Antes o banner prometia
   entrega gratis mas o total so caia DEPOIS de finalizar. */
let fidelidadeCheckout = null;
function premioEntregaGratisValendo() {
  return !!(fidelidadeCheckout && fidelidadeCheckout.premio_disponivel
    && fidelidadeCheckout.premio_tipo === 'entrega_gratis');
}
async function consultarFidelidadeCheckout() {
  const el = $('#ck-fidelidade');
  const digitos = soDigitos($('#ck-whats').value);
  if (digitos.length < 10) { fidelidadeCheckout = null; el.hidden = true; atualizarResumoCheckout(); return; }
  try {
    const r = await fetch(`/api/public/fidelidade/${digitos}`).then(x => x.json());
    if (!r || !r.ativo) { fidelidadeCheckout = null; el.hidden = true; atualizarResumoCheckout(); return; }
    fidelidadeCheckout = { ...r, _digitos: digitos };
    if (r.premio_disponivel) {
      el.innerHTML = r.premio_tipo === 'entrega_gratis'
        ? '🎉 Você tem um prêmio de fidelidade: <strong>a entrega deste pedido sai grátis!</strong>'
        : `🎉 Você tem um prêmio de fidelidade esperando: <strong>${esc(r.premio_texto)}</strong> — a loja já está avisada.`;
      el.hidden = false;
    } else if (r.compras >= 1) {
      el.innerHTML = `💜 Que bom te ver de volta! Você já fez ${r.compras} ${r.compras === 1 ? 'compra' : 'compras'} — faltam ${r.faltam} para ganhar: <strong>${esc(r.premio_texto)}</strong>.`;
      el.hidden = false;
    } else { el.hidden = true; }
  } catch { fidelidadeCheckout = null; el.hidden = true; }
  atualizarResumoCheckout();
}
/* Fidelidade (v1.9.17): ao terminar de digitar o WhatsApp, o sistema
   reconhece o cliente que voltou e mostra a novidade já no checkout. */
$('#ck-whats').addEventListener('change', consultarFidelidadeCheckout);
function parseReais(txt) {
  const s = String(txt || '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.round(n * 100);
}
function taxaBruta() {
  if (tipoRecebimento === 'retirada') return 0;
  const sel = $('#ck-bairro').value;
  const b = bairros.find((x) => String(x.id) === String(sel));
  if (b) return b.taxa_centavos || 0;
  if (!bairros.length && loja && loja.taxa_unica_centavos != null) return loja.taxa_unica_centavos;
  return null; // ainda não dá para calcular
}
/* A taxa que VALE na finalizacao: com premio de entrega gratis
   disponivel, ela ja entra ZERADA no resumo e no botao de confirmar —
   espelho exato da regra do servidor (entrega + taxa > 0 + premio). */
function taxaAtual() {
  const t = taxaBruta();
  if (t !== null && t > 0 && tipoRecebimento === 'entrega' && premioEntregaGratisValendo()) return 0;
  return t;
}
function taxaZeradaPeloPremio() {
  const t = taxaBruta();
  return t !== null && t > 0 && tipoRecebimento === 'entrega' && premioEntregaGratisValendo();
}
/* Taxa que já dá para mostrar no carrinho (v1.16.32): taxa única da
   loja, ou a do bairro salvo de compras anteriores. Se não dá para
   saber (sem bairro salvo e sem taxa única), o carrinho mantém o
   aviso de sempre — o checkout recalcula de qualquer jeito. */
function taxaConhecidaCarrinho() {
  if (!Array.isArray(bairros)) return null;
  if (!bairros.length && loja && loja.taxa_unica_centavos != null)
    return { valor: loja.taxa_unica_centavos, salvo: false };
  let salvo = {};
  try { salvo = JSON.parse(localStorage.getItem('loja_cliente') || '{}'); } catch {}
  const b = salvo.bairro_id != null ? bairros.find((x) => String(x.id) === String(salvo.bairro_id)) : null;
  if (b) return { valor: b.taxa_centavos || 0, salvo: true };
  return null;
}
/* Cupom (v1.14.0): a prévia usa tipo/valor que o SERVIDOR devolveu na
   validação; o desconto oficial é recalculado no servidor ao criar o pedido. */
let cupomAplicado = null; // {codigo, tipo, valor}
function descontoCupom(sub) {
  if (!cupomAplicado) return 0;
  const d = cupomAplicado.tipo === 'percentual'
    ? Math.floor(sub * Math.min(100, cupomAplicado.valor) / 100)
    : Math.min(cupomAplicado.valor, sub);
  return Math.max(0, Math.min(d, sub));
}
async function aplicarCupom(silencioso) {
  const codigo = $('#ck-cupom').value.trim();
  const msg = $('#ck-cupom-msg');
  if (!codigo) { cupomAplicado = null; msg.hidden = true; atualizarResumoCheckout(); return; }
  try {
    const r = await fetch('/api/public/cupom/validar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codigo, subtotal_centavos: subtotalCarrinho() }),
    }).then(x => x.json());
    if (!r.ok) throw new Error(r.erro || 'Cupom inválido.');
    cupomAplicado = { codigo: r.codigo, tipo: r.tipo, valor: r.valor };
    msg.textContent = `Cupom ${r.codigo} aplicado: -${R$(r.desconto_centavos)} neste pedido.`;
    msg.className = 'cupom-msg ok'; msg.hidden = false;
  } catch (e) {
    cupomAplicado = null;
    if (!silencioso) { msg.textContent = e.message; msg.className = 'cupom-msg erro'; msg.hidden = false; }
    else msg.hidden = true;
  }
  atualizarResumoCheckout();
}
$('#btn-cupom').addEventListener('click', () => aplicarCupom(false));
/* Recuperador (v1.14.0): avisa a loja que um cliente identificado montou um
   pedido — se ele não finalizar, a loja pode chamá-lo de volta. */
let ultimaIntencao = 0;
function registrarIntencao() {
  const agora = Date.now();
  if (agora - ultimaIntencao < 20000) return;
  const whatsEl = $('#ck-whats');
  if (!whatsEl) return;
  const whats = soDigitos(whatsEl.value);
  if (whats.length < 10 || !carrinho.length) return;
  ultimaIntencao = agora;
  fetch('/api/public/intencao', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      whatsapp: whats,
      nome: ($('#ck-nome') || {}).value || '',
      itens: carrinho.map(i => ({ nome: i.nome, quantidade: i.quantidade })),
      total_centavos: subtotalCarrinho(),
    }),
  }).catch(() => {});
}
$('#ck-whats').addEventListener('change', registrarIntencao);
function atualizarResumoCheckout() {
  const sub = subtotalCarrinho();
  const taxa = taxaAtual();
  const desconto = descontoCupom(sub);
  $('#rs-subtotal').textContent = R$(sub);
  $('#rs-taxa').textContent = taxa === null ? 'a calcular'
    : (taxaZeradaPeloPremio() ? 'Grátis — prêmio de fidelidade'
    : (taxa === 0 ? 'Grátis' : R$(taxa)));
  $('#rs-desconto-linha').hidden = desconto <= 0;
  if (desconto > 0) { $('#rs-cupom-codigo').textContent = cupomAplicado.codigo; $('#rs-desconto').textContent = '-' + R$(desconto); }
  $('#rs-total').textContent = R$(sub - desconto + (taxa || 0));
  // v1.16.32: com a taxa ainda desconhecida, o total é PARCIAL — o rótulo
  // e o botão dizem isso, em vez de o cliente confirmar achando que é
  // o valor final.
  const rotTotal = $('#rs-total-rot');
  if (rotTotal) rotTotal.textContent = taxa === null ? 'Total parcial' : 'TOTAL';
  const btn = $('#btn-confirmar');
  btn.textContent = taxa === null
    ? `Confirmar pedido • ${R$(sub - desconto)} + taxa`
    : `Confirmar pedido • ${R$(sub - desconto + (taxa || 0))}`;
  const avisoMin = $('#rs-minimo');
  let bloqueia = false;
  if (loja && loja.pedido_minimo_centavos > 0 && sub < loja.pedido_minimo_centavos) {
    avisoMin.textContent = `Pedido mínimo de ${R$(loja.pedido_minimo_centavos)} — falta ${R$(loja.pedido_minimo_centavos - sub)}.`;
    avisoMin.hidden = false; bloqueia = true;
  } else avisoMin.hidden = true;
  if (loja && !loja.aberta) bloqueia = true;
  btn.disabled = bloqueia;
}
function renderBairrosCheckout() {
  const sel = $('#ck-bairro');
  sel.innerHTML = '';
  if (!bairros.length) {
    const op = document.createElement('option');
    op.value = ''; op.textContent = loja && loja.taxa_unica_centavos != null ? 'Entrega (taxa única da loja)' : 'Entrega (taxa a calcular)';
    sel.appendChild(op);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const op0 = document.createElement('option');
  op0.value = ''; op0.textContent = 'Selecione seu bairro…';
  sel.appendChild(op0);
  for (const b of bairros) {
    const op = document.createElement('option');
    op.value = b.id;
    op.textContent = `${b.bairro} — ${b.taxa_centavos === 0 ? 'grátis' : R$(b.taxa_centavos)}`;
    sel.appendChild(op);
  }
}
function renderPagamentosCheckout() {
  const lista = (loja && Array.isArray(loja.metodos_pagamento) && loja.metodos_pagamento.length)
    ? loja.metodos_pagamento : METODOS_PADRAO;
  const cont = $('#ck-pagamentos');
  cont.innerHTML = '';
  for (const m of lista) {
    const online = m.online != null ? !!m.online : ONLINE_SET.has(m.codigo);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pag-opcao' + (pagamentoSel === m.codigo ? ' selecionada' : '');
    b.innerHTML = `<span class="pag-rotulo">${esc(m.rotulo || ROTULOS_PAG[m.codigo] || m.codigo)}</span>
      ${online ? '<span class="pag-online">ONLINE</span>' : ''}`;
    b.addEventListener('click', () => {
      pagamentoSel = m.codigo;
      renderPagamentosCheckout();
      $('#ck-troco-wrap').hidden = pagamentoSel !== 'dinheiro';
      $('#ck-pag-online-aviso').hidden = !online;
    });
    cont.appendChild(b);
  }
  if (!pagamentoSel && lista.length) {
    pagamentoSel = lista[0].codigo;
    renderPagamentosCheckout();
    const primeiroOnline = (lista[0].online != null ? !!lista[0].online : ONLINE_SET.has(lista[0].codigo));
    $('#ck-troco-wrap').hidden = pagamentoSel !== 'dinheiro';
    $('#ck-pag-online-aviso').hidden = !primeiroOnline;
  }
}
function definirTipo(tipo) {
  tipoRecebimento = tipo;
  $$('#ck-tipo button').forEach((b) => b.classList.toggle('seg-ativo', b.dataset.tipo === tipo));
  $('#ck-endereco').hidden = tipo === 'retirada';
  atualizarResumoCheckout();
}
$$('#ck-tipo button').forEach((b) => b.addEventListener('click', () => definirTipo(b.dataset.tipo)));
$('#ck-bairro').addEventListener('change', atualizarResumoCheckout);

function abrirCheckout() {
  let salvo = {};
  try { salvo = JSON.parse(localStorage.getItem('guri_cliente') || '{}'); } catch {}
  if (salvo.nome) $('#ck-nome').value = salvo.nome;
  if (salvo.whatsapp) { const w = $('#ck-whats'); w.value = mascararFone(salvo.whatsapp); w.dataset.digitos = soDigitos(salvo.whatsapp).length; }
  if (salvo.rua) $('#ck-rua').value = salvo.rua;
  if (salvo.numero) $('#ck-numero').value = salvo.numero;
  if (salvo.complemento) $('#ck-complemento').value = salvo.complemento;
  if (salvo.referencia) $('#ck-referencia').value = salvo.referencia;
  renderBairrosCheckout();
  if (salvo.bairro_id) $('#ck-bairro').value = salvo.bairro_id;
  // WhatsApp salvo de compras anteriores: consulta a fidelidade ja na
  // abertura, pro desconto do premio aparecer sem o cliente tocar no campo.
  if (salvo.whatsapp) consultarFidelidadeCheckout();
  // Sorteio divulgado (v1.16.9): o aviso tambem aparece na finalizacao.
  const ckSorteio = $('#ck-sorteio');
  if (ckSorteio) {
    if (sorteioAtivoLoja) {
      ckSorteio.innerHTML = `${icLoja('trophy')} <strong>Sorteio rolando:</strong> ${esc(sorteioAtivoLoja.titulo)} — prêmio: <strong>${esc(sorteioAtivoLoja.premio)}</strong>. Finalizando este pedido, você participa automaticamente!`;
      ckSorteio.hidden = false;
    } else { ckSorteio.hidden = true; }
  }
  renderPagamentosCheckout();
  definirTipo('entrega');
  const erro = $('#ck-erro');
  if (loja && !loja.aberta) {
    erro.textContent = loja.pausada
      ? 'A loja está pausada e não está recebendo pedidos no momento.'
      : 'A loja está fechada e não está recebendo pedidos no momento.';
    erro.hidden = false;
  } else erro.hidden = true;
  atualizarResumoCheckout();
  registrarIntencao();
  abrirOverlay('checkout');
}
function erroCheckout(msg) {
  const e = $('#ck-erro');
  e.textContent = msg;
  e.hidden = false;
  e.scrollIntoView({ behavior: reduzMotion ? 'auto' : 'smooth', block: 'center' });
}
$('#form-checkout').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!carrinho.length) return erroCheckout('Seu pedido está vazio.');
  const nome = $('#ck-nome').value.trim();
  const whats = soDigitos($('#ck-whats').value);
  if (nome.length < 2) return erroCheckout('Conte pra gente seu nome');
  if (whats.length < 10 || whats.length > 13) return erroCheckout('Confira seu WhatsApp (DDD + número).');
  if (!pagamentoSel) return erroCheckout('Escolha a forma de pagamento.');
  let bairro_id = null, endereco = null;
  if (tipoRecebimento === 'entrega') {
    const rua = $('#ck-rua').value.trim();
    const numero = $('#ck-numero').value.trim();
    if (bairros.length) {
      bairro_id = $('#ck-bairro').value || null;
      if (!bairro_id) return erroCheckout('Selecione seu bairro para calcularmos a entrega.');
    }
    if (!rua) return erroCheckout('Informe a rua da entrega.');
    if (!numero) return erroCheckout('Informe o número da casa/prédio.');
    endereco = {
      rua, numero,
      complemento: $('#ck-complemento').value.trim(),
      referencia: $('#ck-referencia').value.trim(),
    };
  }
  let troco = null;
  if (pagamentoSel === 'dinheiro') {
    const t = parseReais($('#ck-troco').value);
    if (t != null) {
      const taxa = taxaAtual() || 0;
      if (t < subtotalCarrinho() + taxa) return erroCheckout('O valor do troco é menor que o total do pedido.');
      troco = t;
    }
  }
  const payload = {
    cliente_nome: nome,
    cliente_whatsapp: whats,
    tipo: tipoRecebimento,
    bairro_id,
    endereco,
    cupom_codigo: cupomAplicado ? cupomAplicado.codigo : undefined,
    forma_pagamento: pagamentoSel,
    troco_para_centavos: troco,
    observacao: $('#ck-obs').value.trim(),
    itens: carrinho.map((i) => ({
      produto_id: i.produto_id, quantidade: i.quantidade,
      observacao: i.observacao || '', opcoes: i.opcoes,
    })),
  };
  // Corte (v1.16.14): avisa antes de enviar e mantem o carrinho — o
  // servidor barra de qualquer forma, mas o cliente nao espera a volta.
  const corte = msgCorteCliente();
  if (corte) { erroCheckout(corte); return; }
  const btn = $('#btn-confirmar');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const r = await fetch('/api/public/pedidos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(dados.erro || 'Não foi possível enviar o pedido. Tente de novo.');
    ultimoPagamento = dados.pagamento || null;
    try {
      localStorage.setItem('guri_cliente', JSON.stringify({
        nome, whatsapp: whats, bairro_id,
        rua: endereco?.rua || '', numero: endereco?.numero || '',
        complemento: endereco?.complemento || '', referencia: endereco?.referencia || '',
      }));
    } catch {}
    carrinho = [];
    salvarCarrinho();
    fecharOverlay('checkout');
    toast(`Pedido #${dados.numero} enviado!`);
    irParaAcompanhamento(dados.token);
  } catch (e) {
    erroCheckout(e.message || 'Algo deu errado. Seu pedido continua no carrinho — tente de novo.');
  } finally {
    btn.disabled = false;
    atualizarResumoCheckout();
  }
});

/* ============================================================
   ACOMPANHAMENTO DO PEDIDO
   ============================================================ */
const STATUS_TXT = {
  NOVO: 'Recebemos seu pedido! Aguardando a confirmação da loja.',
  EM_PREPARO: 'Pedido confirmado! Já estamos preparando seu açaí.',
  PRONTO: 'Seu pedido está pronto!',
  SAIU_ENTREGA: 'Seu açaí saiu para entrega!',
  ENTREGUE: 'Pedido entregue. Bom açaí!',
  CANCELADO: 'Este pedido foi cancelado.',
};
let tokenAcomp = null;
let timerAcomp = null;

/* Sons do acompanhamento (v1.16.7; arquivos reais na v1.16.10 — o
   Gabriel mandou os dois MP3): quando o pedido SAI pra entrega, toca
   a moto acelerando (public/sons/moto.mp3); quando ENTREGUE, a buzina
   (public/sons/buzina.mp3). Regra do navegador: audio so toca depois
   de algum toque do cliente na pagina — por isso os audios sao
   "destravados" no primeiro toque (um play em silencio), e uma virada
   de status sem toque nenhum fica esperando (ate 30s) pelo primeiro
   toque. O cliente pode desligar no alto-falante do proprio cartao; a
   escolha fica salva no aparelho. Nada aqui pode quebrar a tela:
   tudo em try/catch. */
const SONS_ACOMP = {
  partida: (() => { try { const a = new Audio('/sons/moto.mp3'); a.preload = 'auto'; return a; } catch { return null; } })(),
  buzina: (() => { try { const a = new Audio('/sons/buzina.mp3'); a.preload = 'auto'; return a; } catch { return null; } })(),
};
let somDestravado = false;
let somPendente = null; // { tipo, quando }
function somDesligado() { try { return localStorage.getItem('loja_sem_som') === '1'; } catch { return false; } }
function destravarSom() {
  if (somDestravado) return;
  somDestravado = true;
  for (const a of Object.values(SONS_ACOMP)) {
    if (!a) continue;
    try {
      a.muted = true;
      const p = a.play();
      if (p && p.then) p.then(() => { try { a.pause(); a.currentTime = 0; a.muted = false; } catch { /* ok */ } }).catch(() => { a.muted = false; });
    } catch { /* ok */ }
  }
}
document.addEventListener('pointerdown', () => {
  if (somDesligado()) return;
  destravarSom();
  if (somPendente && Date.now() - somPendente.quando < 30000) tocarSomAcomp(somPendente.tipo);
  somPendente = null;
}, true);
function dispararSomAcomp(tipo) {
  if (somDesligado()) return;
  if (!somDestravado) { somPendente = { tipo, quando: Date.now() }; return; }
  tocarSomAcomp(tipo);
}
function tocarSomAcomp(tipo) {
  if (somDesligado()) return;
  const a = SONS_ACOMP[tipo];
  if (!a) return;
  try { a.currentTime = 0; const p = a.play(); if (p && p.catch) p.catch(() => { /* navegador segurou */ }); } catch { /* som nunca trava a tela */ }
}

function linhasOpcoesPedido(item) {
  const ops = item.opcoes || [];
  if (!ops.length) return '';
  const grupos = new Map();
  for (const o of ops) {
    if (typeof o === 'string') {
      if (!grupos.has('')) grupos.set('', []);
      grupos.get('').push(o);
    } else {
      const g = o.grupo_nome_snapshot || o.grupo_nome || '';
      if (!grupos.has(g)) grupos.set(g, []);
      grupos.get(g).push(o.opcao_nome_snapshot || o.nome || '');
    }
  }
  return Array.from(grupos.entries())
    .map(([g, ns]) => (g ? `${g}: ${ns.join(', ')}` : ns.join(', '))).join('\n');
}
function enderecoTextoPedido(d) {
  const e = d.endereco;
  if (!e) return d.endereco_texto || '';
  if (typeof e === 'string') return e;
  const partes = [e.rua && `${e.rua}, ${e.numero || 's/n'}`, e.complemento, d.bairro_nome || d.bairro, e.referencia && `Ref.: ${e.referencia}`];
  return partes.filter(Boolean).join(' • ');
}
function renderAcompanhamento(d) {
  const cont = $('#acompanhamento');
  const etapasBase = d.tipo === 'retirada'
    ? ['NOVO', 'EM_PREPARO', 'PRONTO', 'ENTREGUE']
    : ['NOVO', 'EM_PREPARO', 'PRONTO', 'SAIU_ENTREGA', 'ENTREGUE'];
  const NOMES_ETAPA = {
    NOVO: 'Pedido recebido', EM_PREPARO: 'Em preparo', PRONTO: d.tipo === 'retirada' ? 'Pronto para retirada' : 'Pronto',
    SAIU_ENTREGA: 'Saiu para entrega', ENTREGUE: 'Entregue',
  };
  const idxAtual = etapasBase.indexOf(d.status);
  const horas = {};
  let motivoCancel = '';
  for (const h of d.historico || []) {
    const st = h.para_status || h.status;
    if (st && !horas[st]) horas[st] = formatarHora(h.criado_em || h.created_at);
    if (st === 'CANCELADO' && h.motivo) motivoCancel = h.motivo;
  }
  const cancelado = d.status === 'CANCELADO';
  /* A animacao do motoboy vai DENTRO da linha do tempo, literalmente
     abaixo da etapa "Saiu para entrega" (v1.16.8 — correcao do
     Gabriel: nao e sob o titulo do cartao, e sob a ETAPA; assim o
     cliente que acompanha as etapas ve a moto no passo certo). */
  const motoTimelineHTML = (d.tipo === 'entrega' && d.status === 'SAIU_ENTREGA') ? `
    <div class="tl-moto">
      <div class="moto-cena rapido" aria-hidden="true">
        <span class="moto-vento v1"></span><span class="moto-vento v2"></span><span class="moto-vento v3"></span>
        <img class="moto-img" src="/img/motoboy.png" alt="">
        <span class="moto-chao"></span>
      </div>
      <p class="moto-legenda">Ele já está a caminho da sua casa!</p>
    </div>` : '';
  const timeline = cancelado ? '' : `<div class="timeline">${etapasBase.map((st, i) => `
    <div class="tl-etapa ${i < idxAtual ? 'feita' : ''} ${i === idxAtual ? 'atual feita' : ''}">
      <span class="tl-bola">${i < idxAtual || i === idxAtual ? icLoja('check') : ''}</span>
      <div class="tl-textos">
        <div class="tl-nome">${NOMES_ETAPA[st]}</div>
        ${horas[st] ? `<div class="tl-hora">às ${horas[st]}</div>` : ''}
      </div>
    </div>${st === 'SAIU_ENTREGA' ? motoTimelineHTML : ''}`).join('')}</div>`;

  /* pagamento online */
  const pag = d.pagamento || ultimoPagamento;
  const pagStatus = d.pagamento_status || (pag && pag.status);
  const online = ONLINE_SET.has(d.forma_pagamento) || !!pag;
  let pagHTML = '';
  if (online && pagStatus === 'pago') {
    pagHTML = `<div class="pago-box">${icLoja('checkCirculo')} Pagamento online confirmado</div>`;
  } else if (online && pagStatus === 'pendente') {
    pagHTML = `<div class="pagamento-box">
      <h3>Aguardando pagamento</h3>
      <p>Seu pedido já está reservado. Pague para confirmarmos tudo por aqui:</p>
      ${pag && pag.qr_texto ? `<div class="qr-texto" id="qr-texto">${esc(pag.qr_texto)}</div>
        <button type="button" class="btn-secundario" id="btn-copiar-qr">${icLoja('copiar')} Copiar código Pix</button>` : ''}
      ${pag && pag.link_pagamento ? `<br><a class="btn-primario" style="display:inline-flex;align-items:center;text-decoration:none;margin-top:12px" href="${esc(pag.link_pagamento)}" target="_blank" rel="noopener">${icLoja('cartao')} Pagar agora</a>` : ''}
      ${!pag || (!pag.qr_texto && !pag.link_pagamento) ? '<p>Gerando os dados de pagamento… atualizando automaticamente.</p>' : ''}
    </div>`;
  } else if (online && (pagStatus === 'falhou' || pagStatus === 'erro_config')) {
    pagHTML = `<div class="cancelado-box">Houve um problema com o pagamento online. Não se preocupe: a loja vai te chamar no WhatsApp para combinar outra forma.</div>`;
  }

  const itensHTML = (d.itens || []).map((it) => {
    const nome = it.nome_snapshot || it.nome || 'Item';
    const unit = it.preco_unitario_centavos != null ? it.preco_unitario_centavos : (it.preco_centavos || 0);
    const sub = it.subtotal_centavos != null ? it.subtotal_centavos : unit * (it.quantidade || 1);
    const ops = linhasOpcoesPedido(it);
    return `<div class="acomp-item">
      <div class="acomp-item-nome"><span>${it.quantidade || 1}× ${esc(nome)}</span><span>${R$(sub)}</span></div>
      ${ops ? `<p class="acomp-item-ops">${esc(ops)}</p>` : ''}
      ${it.observacao ? `<p class="acomp-item-ops">“${esc(it.observacao)}”</p>` : ''}
    </div>`;
  }).join('');

  const rotuloPag = ROTULOS_PAG[d.forma_pagamento] || d.forma_pagamento || '';
  const zapLoja = loja && loja.whatsapp ? soDigitos(loja.whatsapp) : '';
  /* Código de entrega (v1.9): destaque pro cliente guardar e informar ao
     entregador — sem ele, a loja não consegue dar baixa no pedido. */
  const codigoHTML = (d.codigo_entrega && !['ENTREGUE', 'CANCELADO'].includes(d.status)) ? `
    <div class="codigo-box">
      <span class="codigo-rot">${icLoja('chave')} Seu código de entrega</span>
      <strong class="codigo-num">${esc(d.codigo_entrega)}</strong>
      <span class="codigo-dica">${d.tipo === 'retirada' ? 'Informe este código no balcão ao retirar seu pedido.' : 'Informe este código ao entregador quando seu pedido chegar.'}</span>
    </div>` : '';
  /* Motoboy animado (v1.9.8; v1.9.9: compacto e SÓ ao sair pra entrega —
     pedido do Gabriel): cena em CSS puro na tela do cliente. */
  /* Fidelidade (v1.9.17): cartão do programa — prêmio ganho, boas-vindas de
     quem voltou (com o progresso até a meta) ou apresentação p/ a 1ª compra. */
  const f = d.fidelidade;
  let fidelHTML = '';
  if (f && f.ativo && !cancelado) {
    const primeiroNome = String(d.cliente_nome || '').trim().split(' ')[0];
    if (f.premio) {
      fidelHTML = `<div class="fidel-card ganhou">
        <div class="fidel-tit">${icLoja('trophy')} Você ganhou um prêmio!</div>
        <p class="fidel-premio"><strong>${esc(f.premio.texto)}</strong></p>
        <p class="fidel-sub">${f.premio.tipo === 'entrega_gratis'
          ? 'Ele entra sozinho no seu próximo pedido — é só pedir de novo por aqui.'
          : 'É só fazer seu próximo pedido por aqui e avisar a loja que você tem um prêmio de fidelidade.'}</p>
      </div>`;
    } else if (f.compras >= 1) {
      const dots = Array.from({ length: f.meta }, (_, i) => `<span class="fidel-dot ${i < f.no_ciclo ? 'on' : ''}"></span>`).join('');
      fidelHTML = `<div class="fidel-card">
        <div class="fidel-tit">${icLoja('trophy')} Programa de fidelidade</div>
        <p>Que bom te ver de volta${primeiroNome ? ', ' + esc(primeiroNome) : ''}! Sinal de que gostou.</p>
        <div class="fidel-dots">${dots}</div>
        <p class="fidel-sub">Você já fez ${f.compras} ${f.compras === 1 ? 'compra' : 'compras'} com a gente. Faltam ${f.faltam} para ganhar: <strong>${esc(f.premio_texto)}</strong>.</p>
      </div>`;
    } else {
      fidelHTML = `<div class="fidel-card">
        <div class="fidel-tit">${icLoja('trophy')} Programa de fidelidade</div>
        <p class="fidel-sub">A cada ${f.meta} compras entregues, você ganha: <strong>${esc(f.premio_texto)}</strong>. Esta já é a sua compra nº 1 — está valendo!</p>
      </div>`;
    }
  }
  cont.innerHTML = `
  <div class="acomp-card">
    <div class="acomp-topo">
      <div class="acomp-numero">Pedido #${d.numero}</div>
      ${d.tipo === 'entrega' && !cancelado ? `<button type="button" id="btn-som-acomp" class="btn-som" aria-label="${somDesligado() ? 'Ligar os sons do acompanhamento' : 'Desligar os sons do acompanhamento'}" title="${somDesligado() ? 'Sons desligados' : 'Sons ligados'}">${icLoja(somDesligado() ? 'mudo' : 'som')}</button>` : ''}
    </div>
    <p class="acomp-status-txt">${esc(STATUS_TXT[d.status] || d.status)}</p>
    ${d.sorteio && !cancelado ? `<p class="acomp-sorteio">${icLoja('trophy')} Você está participando do sorteio <strong>${esc(d.sorteio.titulo)}</strong> — prêmio: <strong>${esc(d.sorteio.premio)}</strong>. Boa sorte!</p>` : ''}
    ${fidelHTML}
    ${codigoHTML}
    ${cancelado ? `<div class="cancelado-box">Pedido cancelado${motivoCancel ? ` — ${esc(motivoCancel)}` : ''}.</div>` : timeline}
    ${pagHTML}
    <h3 class="detalhes-titulo" style="margin-top:20px">Detalhes</h3>
    ${itensHTML}
    <div style="margin-top:10px">
      <div class="detalhe-linha"><span>Subtotal</span><span>${R$(d.subtotal_centavos || 0)}</span></div>
      <div class="detalhe-linha"><span>Taxa de entrega</span><span>${d.tipo === 'retirada' ? 'Retirada' : R$(d.taxa_entrega_centavos || 0)}</span></div>
      <div class="detalhe-linha"><span><strong>Total</strong></span><span><strong>${R$(d.total_centavos || 0)}</strong></span></div>
      ${rotuloPag ? `<div class="detalhe-linha"><span>Pagamento</span><span>${esc(rotuloPag)}${d.troco_para_centavos ? ` • troco para ${R$(d.troco_para_centavos)}` : ''}</span></div>` : ''}
      ${d.tipo === 'entrega' && enderecoTextoPedido(d) ? `<div class="detalhe-linha"><span>Entrega em</span><span style="text-align:right">${esc(enderecoTextoPedido(d))}</span></div>` : ''}
    </div>
    ${zapLoja ? `<a class="btn-zap" href="https://wa.me/${zapLoja}?text=${encodeURIComponent(`Oi! É sobre meu pedido #${d.numero}`)}" target="_blank" rel="noopener">${icLoja('chat')} Chamar a loja no WhatsApp</a>` : ''}
    <button type="button" class="btn-secundario" id="btn-novo-pedido" style="width:100%">Fazer um novo pedido</button>
  </div>`;
  const btnCopiar = $('#btn-copiar-qr');
  if (btnCopiar) btnCopiar.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#qr-texto').textContent.trim()); toast('Código Pix copiado!'); }
    catch { toast('Selecione o código e copie manualmente.'); }
  });
  const btnNovo = $('#btn-novo-pedido');
  if (btnNovo) btnNovo.addEventListener('click', voltarParaLoja);
  const btnSom = $('#btn-som-acomp');
  if (btnSom) btnSom.addEventListener('click', () => {
    const desligado = !somDesligado();
    try { localStorage.setItem('loja_sem_som', desligado ? '1' : '0'); } catch { /* sem storage */ }
    if (desligado) { for (const a of Object.values(SONS_ACOMP)) { try { if (a) a.pause(); } catch { /* ok */ } } somPendente = null; }
    btnSom.innerHTML = icLoja(desligado ? 'mudo' : 'som');
    btnSom.title = desligado ? 'Sons desligados' : 'Sons ligados';
    toast(desligado ? 'Sons do acompanhamento desligados.' : 'Sons do acompanhamento ligados.');
  });
}
let statusAnteriorAcomp = undefined; // undefined = primeira carga desta tela
async function carregarAcompanhamento() {
  if (!tokenAcomp) return;
  try {
    const d = await getJSON('/api/public/pedidos/' + encodeURIComponent(tokenAcomp));
    /* Sons das viradas (v1.16.7): a virada acontece com a tela aberta;
       se a tela JA abre no status, o som espera o primeiro toque. */
    if (statusAnteriorAcomp !== undefined && statusAnteriorAcomp !== d.status) {
      if (d.status === 'SAIU_ENTREGA') dispararSomAcomp('partida');
      else if (d.status === 'ENTREGUE') dispararSomAcomp('buzina');
    } else if (statusAnteriorAcomp === undefined) {
      if (d.status === 'SAIU_ENTREGA') somPendente = { tipo: 'partida', quando: Date.now() };
      else if (d.status === 'ENTREGUE') somPendente = { tipo: 'buzina', quando: Date.now() };
    }
    statusAnteriorAcomp = d.status;
    renderAcompanhamento(d);
    if (d.status === 'ENTREGUE' || d.status === 'CANCELADO') pararPolling();
  } catch {
    $('#acompanhamento').innerHTML = '<div class="acomp-card"><p class="acomp-status-txt">Não encontramos este pedido. Confira o link ou chame a loja no WhatsApp.</p></div>';
    pararPolling();
  }
}
function pararPolling() { if (timerAcomp) { clearInterval(timerAcomp); timerAcomp = null; } }
function iniciarAcompanhamento(token) {
  tokenAcomp = token;
  statusAnteriorAcomp = undefined;
  somPendente = null;
  pararPolling();
  carregarAcompanhamento();
  timerAcomp = setInterval(carregarAcompanhamento, 5000);
}

/* ============================================================
   ROTEADOR (hash)
   ============================================================ */
/* Navegacao do acompanhamento (v1.16.17): link limpo /pedido/CODIGO.
   O link antigo #/pedido/... continua funcionando (compat). */
function irParaAcompanhamento(token) {
  history.pushState(null, '', '/pedido/' + encodeURIComponent(token));
  roteador();
}
function voltarParaLoja() {
  history.pushState(null, '', '/');
  roteador();
}
function roteador() {
  const mp = location.pathname.match(/^\/pedido\/(.+)$/);
  const m = mp ? [null, mp[1]] : location.hash.match(/^#\/pedido\/(.+)$/);
  document.body.classList.toggle('hdr-solido', !!m);
  if (m) {
    $('#view-loja').hidden = true;
    $('#view-pedido').hidden = false;
    renderBarraCarrinho();
    window.scrollTo(0, 0);
    atualizarCabecalho();
    iniciarAcompanhamento(decodeURIComponent(m[1]));
  } else {
    pararPolling();
    tokenAcomp = null;
    $('#view-pedido').hidden = true;
    $('#view-loja').hidden = false;
    renderBarraCarrinho();
    atualizarCabecalho();
  }
}
window.addEventListener('hashchange', roteador);
window.addEventListener('popstate', roteador);
$('#btn-voltar-loja').addEventListener('click', voltarParaLoja);

document.addEventListener('DOMContentLoaded', iniciar);

/* Voltar ao topo (v1.9.23): surge após rolar um tanto; sobe um degrau
   quando a barra do carrinho aparece (nunca fica escondido atrás dela). */
(function () {
  const btn = document.querySelector('#btn-topo');
  if (!btn) return;
  const barra = document.querySelector('#barra-carrinho');
  const avaliar = () => {
    btn.classList.toggle('visivel', window.scrollY > 500);
    btn.classList.toggle('acima', !!(barra && !barra.hidden));
  };
  let tick = false;
  window.addEventListener('scroll', () => {
    if (!tick) { tick = true; requestAnimationFrame(() => { avaliar(); tick = false; }); }
  }, { passive: true });
  if (barra && window.MutationObserver) {
    new MutationObserver(avaliar).observe(barra, { attributes: true, attributeFilter: ['hidden'] });
  }
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  avaliar();
})();

/* Tema (v1.9.29): a cor da barra do navegador acompanha o tema da loja. */
(function () {
  try {
    const deep = getComputedStyle(document.documentElement).getPropertyValue('--deep').trim();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (deep && meta) meta.setAttribute('content', deep);
  } catch { /* visual apenas */ }
})();
