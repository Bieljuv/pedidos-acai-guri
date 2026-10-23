'use strict';
/* ================= Painel da Empresa — Açaí do Guri ================= */
const $  = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const BRL = new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' });
const fmtBRL = (cent) => BRL.format((Number(cent)||0)/100);
/* O banco guarda as datas em UTC ("2026-10-21 04:05:06", sem fuso). Sem o 'Z',
   o navegador lê como horário local e mostra 3h a mais — aqui convertemos certo
   pro horário de quem está vendo (Brasília). */
function dataServidor(iso) {
  if (!iso) return null;
  let s = String(iso);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

/* ---------- Ícones SVG (v1.9.2: sprite oficial public/icons.js) ----------
   O sprite (window.ic) é a fonte única dos desenhos em todo o sistema;
   aqui só mapeamos os nomes históricos do painel pros símbolos dele. */
const IC_MAPA = {
  recibo: 'receipt', livro: 'book', camadas: 'layers', moto: 'scooter',
  cartao: 'card', loja: 'store', grafico: 'chart', calculadora: 'calculator',
  carteira: 'wallet', pessoas: 'users', pessoa: 'user', relogio: 'clock',
  sino: 'bell', check: 'check', checkCirculo: 'check-circle', x: 'x',
  alerta: 'alert', bandeira: 'flag', impressora: 'print', chat: 'whatsapp',
  pin: 'pin', estrela: 'star', camera: 'camera', dinheiro: 'cash',
  olho: 'eye', olhoOff: 'eye-off', busca: 'search', calendario: 'calendar',
  arquivo: 'file', chave: 'key', copiar: 'copy', voltarSeta: 'arrow-left',
  pausa: 'pause', proibir: 'x-circle',
};
function ic(nome, cls) {
  // window.icSprite: esta declaracao (ic) sobrescreve o window.ic do sprite;
  // o alias do icons.js e o caminho seguro pro helper do sprite.
  if (window.icSprite) return window.icSprite(IC_MAPA[nome] || nome, cls);
  return `<svg class="ic ${cls || ''}" aria-hidden="true"></svg>`;
}

/* ---------- Tema claro/escuro (v1.9: controle segmentado sol/lua) ----------
   O <html data-tema="escuro"> já vem aplicado pelo script do <head>; aqui
   cuidamos dos cliques e da persistência (localStorage 'tema-painel'). */
function aplicarTema(tema) {
  if (tema === 'escuro') document.documentElement.dataset.tema = 'escuro';
  else delete document.documentElement.dataset.tema;
  try { localStorage.setItem('tema-painel', tema); } catch { /* ok */ }
  $$('.tema-seg').forEach(seg => seg.classList.toggle('escuro', tema === 'escuro'));
}
$$('[data-tema-btn]').forEach(b => b.addEventListener('click', () => aplicarTema(b.dataset.temaBtn)));
aplicarTema(document.documentElement.dataset.tema === 'escuro' ? 'escuro' : 'claro');

const state = {
  token: localStorage.getItem('painel_token') || '',
  user: JSON.parse(localStorage.getItem('painel_user') || 'null'),
  loja: null,
  pedidos: [],
  detalheId: null,
  categorias: [], produtos: [], grupos: [], bairros: [],
  recebimentos: {}, configuracoes: null,
  relData: '', relMes: '', finData: '', finTipoSel: 'investimento', finEditandoId: null, finCalculo: null,
  equipe: [], pontoMes: '', ponto: null,
  view: 'pedidos',
  audioCtx: null, somAtivo: false, somTimer: null,
  sse: null, pollTimer: null, pontoTimer: null, alertaSilenciado: false,
};

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  let body = opts.body;
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const res = await fetch(path, { method: opts.method || 'GET', headers, body });
  if (res.status === 401) { sair(false); throw new Error('Sessão expirada. Entre de novo.'); }
  let data = null;
  try { data = await res.json(); } catch { /* sem corpo */ }
  if (res.status === 403) {
    // 403 no login = fora da janela do turno (a mensagem vai pro formulário).
    // Já logado = tentou área de admin: avisa e volta pros Pedidos.
    const msg = (data && data.erro) || 'Sem permissão para esta ação.';
    if (state.user) {
      toast(msg, true);
      if (state.view !== 'pedidos') irPara('pedidos');
    }
    throw new Error(msg);
  }
  if (!res.ok) throw new Error((data && (data.erro || data.message)) || ('Erro ' + res.status));
  return data;
}
async function uploadArquivo(file) {
  const fd = new FormData();
  fd.append('arquivo', file);
  const data = await api('/api/painel/upload', { method: 'POST', body: fd });
  return data.url;
}

/* ---------- Toast ---------- */
function toast(msg, erro = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (erro ? ' erro' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

/* ---------- Dinheiro (input R$ -> centavos) ---------- */
function wireMoney(input) {
  input.addEventListener('input', () => {
    const dig = input.value.replace(/\D/g, '');
    if (!dig) { input.value = ''; input.dataset.centavos = ''; return; }
    const cent = parseInt(dig, 10);
    input.dataset.centavos = String(cent);
    input.value = (cent/100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  });
}
function setMoney(input, cent) {
  if (cent === null || cent === undefined || cent === '') { input.value = ''; input.dataset.centavos = ''; return; }
  input.dataset.centavos = String(cent);
  input.value = (Number(cent)/100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function getMoney(input) {
  if (input.dataset.centavos === '' || input.dataset.centavos === undefined) {
    const dig = input.value.replace(/\D/g, '');
    return dig ? parseInt(dig, 10) : null;
  }
  return parseInt(input.dataset.centavos, 10);
}
$$('.money').forEach(wireMoney);

/* ---------- Modal genérico ---------- */
function openModal(titulo, html) {
  $('#modalTitulo').textContent = titulo;
  $('#modalBody').innerHTML = html;
  $('#modal').classList.remove('hidden');
  $('#modalOverlay').classList.remove('hidden');
  $$('.money', $('#modalBody')).forEach(wireMoney);
  return $('#modalBody');
}
let modalTravado = false; // troca de senha obrigatória (temporária) não fecha
function closeModal() {
  if (modalTravado) return;
  $('#modal').classList.add('hidden'); $('#modalOverlay').classList.add('hidden');
}
$('#modalFechar').addEventListener('click', closeModal);
$('#modalOverlay').addEventListener('click', closeModal);

/* ---------- Autenticação ---------- */
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const erro = $('#loginErro'); erro.classList.add('hidden');
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: { login: $('#loginUser').value.trim(), senha: $('#loginPass').value } });
    state.token = data.token;
    state.user = { nome: data.nome, perfil: data.perfil, precisa_trocar_senha: !!data.precisa_trocar_senha };
    localStorage.setItem('painel_token', state.token);
    localStorage.setItem('painel_user', JSON.stringify(state.user));
    iniciarApp();
    // v1.13.8 (decisao do Gabriel): sem aviso de senha padrao — admin123 fica, sem enchecao.
  } catch (err) {
    erro.textContent = err.message || 'Usuário ou senha inválidos.';
    erro.classList.remove('hidden');
  }
});
function sair(avisar = true) {
  state.token = ''; state.user = null; state.ponto = null;
  localStorage.removeItem('painel_token'); localStorage.removeItem('painel_user');
  if (state.sse) { state.sse.close(); state.sse = null; }
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  if (state.pontoTimer) { clearInterval(state.pontoTimer); state.pontoTimer = null; }
  pararSom(); pararAlertaSaida();
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  if (avisar) toast('Você saiu do painel.');
}
$('#btnSair').addEventListener('click', () => sair(true));

$('#btnTrocarSenha').addEventListener('click', () => {
  const body = openModal('Trocar senha', `
    <form id="formSenha">
      <label>Senha atual <input type="password" id="senhaAtual" autocomplete="current-password" required></label>
      <label>Nova senha <input type="password" id="senhaNova" autocomplete="new-password" minlength="6" required></label>
      <label>Repetir nova senha <input type="password" id="senhaNova2" autocomplete="new-password" minlength="6" required></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Salvar nova senha</button></div>
    </form>`);
  $('#formSenha', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if ($('#senhaNova', body).value !== $('#senhaNova2', body).value) { toast('As senhas novas não conferem.', true); return; }
    try {
      await api('/api/auth/trocar-senha', { method: 'POST', body: { senha_atual: $('#senhaAtual', body).value, nova_senha: $('#senhaNova', body).value } });
      closeModal(); toast('Senha alterada com sucesso.');
    } catch (err) { toast(err.message, true); }
  });
});

/* ---------- Esqueci minha senha (v1.9.22) ---------- */
$('#btnEsqueci').addEventListener('click', () => {
  $('#esqueciBox').classList.toggle('hidden');
  const atual = $('#esqueciLogin').value.trim();
  if (!atual && $('#loginUser').value.trim()) $('#esqueciLogin').value = $('#loginUser').value.trim();
});
$('#btnEsqueciEnviar').addEventListener('click', async () => {
  const login = $('#esqueciLogin').value.trim();
  const ok = $('#esqueciOk');
  if (!login) { ok.textContent = 'Digite seu usuário para enviar o pedido.'; ok.classList.remove('hidden'); return; }
  try {
    const r = await api('/api/public/recuperar-senha', { method: 'POST', body: { login } });
    ok.textContent = (r && r.mensagem) || 'Pedido registrado! O administrador vai gerar sua nova senha e te passar.';
    ok.classList.remove('hidden');
    $('#btnEsqueciEnviar').disabled = true;
  } catch (e) {
    ok.textContent = 'Não consegui enviar agora. Avise o administrador direto, por favor.';
    ok.classList.remove('hidden');
  }
});

// Troca OBRIGATÓRIA ao entrar com a senha temporária: o modal não fecha
// até a pessoa criar a senha dela (o servidor também limpa a marca aqui).
function abrirTrocaSenhaForcada() {
  modalTravado = true;
  $('#modalFechar').classList.add('hidden');
  const body = openModal('Crie sua nova senha', `
    <p class="dica">Você entrou com uma <strong>senha temporária</strong>. Para continuar, crie a sua senha nova agora — a temporária para de valer assim que você salvar.</p>
    <form id="formSenhaForcada">
      <label>Senha temporária (a que você acabou de usar) <input type="password" id="senhaAtualF" autocomplete="current-password" required></label>
      <label>Nova senha <input type="password" id="senhaNovaF" autocomplete="new-password" minlength="6" required></label>
      <label>Repetir nova senha <input type="password" id="senhaNova2F" autocomplete="new-password" minlength="6" required></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Salvar e entrar</button></div>
    </form>`);
  const atualF = $('#senhaAtualF', body);
  if (atualF && $('#loginPass').value) atualF.value = $('#loginPass').value;
  $('#formSenhaForcada', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if ($('#senhaNovaF', body).value !== $('#senhaNova2F', body).value) { toast('As senhas novas não conferem.', true); return; }
    try {
      await api('/api/auth/trocar-senha', { method: 'POST', body: { senha_atual: $('#senhaAtualF', body).value, nova_senha: $('#senhaNovaF', body).value } });
      if (state.user) {
        state.user.precisa_trocar_senha = false;
        localStorage.setItem('painel_user', JSON.stringify(state.user));
      }
      modalTravado = false;
      $('#modalFechar').classList.remove('hidden');
      closeModal();
      toast('Senha nova criada. Bem-vindo(a)!');
    } catch (err) { toast(err.message, true); }
  });
}

/* ---------- Navegação ---------- */
const TITULOS = {
  pedidos: 'Pedidos', cardapio: 'Cardápio', grupos: 'Grupos e Opções', bairros: 'Bairros e Taxas',
  'rec-presencial': 'Meios de Recebimento — Presencial', 'rec-mp': 'Meios de Recebimento — Mercado Pago',
  'rec-asaas': 'Meios de Recebimento — Asaas', loja: 'Loja e Aparência', relatorio: 'Relatório do Dia',
  contabil: 'Contábil', financeiro: 'Financeiro', fidelidade: 'Fidelidade', configuracoes: 'Configurações', equipe: 'Equipe',
  'primeiros-passos': 'Primeiros Passos',
};
function irPara(view) {
  state.view = view;
  $$('.menu-item[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(s => s.classList.add('hidden'));
  const sec = $('#view-' + view);
  if (sec) sec.classList.remove('hidden');
  $('#viewTitle').textContent = TITULOS[view] || view;
  if (view === 'pedidos') carregarPedidos();
  if (view === 'cardapio') carregarCardapio();
  if (view === 'grupos') carregarGrupos();
  if (view === 'bairros') carregarBairros();
  if (view.startsWith('rec-')) carregarRecebimentos();
  if (view === 'loja') preencherLoja();
  if (view === 'relatorio') carregarRelatorioDia();
  if (view === 'contabil') carregarRelatorioMes();
  if (view === 'financeiro') carregarFinanceiro();
  if (view === 'fidelidade') carregarFidelidade();
  if (view === 'configuracoes') carregarConfiguracoes();
  if (view === 'equipe') { carregarEquipe(); carregarPontoRelatorio(); carregarRecuperacao(); }
  if (view === 'primeiros-passos') carregarPassos();
}
$$('.menu-item[data-view]').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.view.startsWith('rec-')) { $('#accReceb').classList.add('open'); $('#accRecebBtn').setAttribute('aria-expanded', 'true'); }
  irPara(b.dataset.view);
}));
$('#accRecebBtn').addEventListener('click', () => {
  const aberto = $('#accReceb').classList.toggle('open');
  $('#accRecebBtn').setAttribute('aria-expanded', String(aberto));
});

/* ---------- Loja: topo (aberta / pausar / saúde) ---------- */
function lojaAbertaCalc(l) {
  return l && l.aberta !== undefined ? !!l.aberta : !!(l && l.aberta_manual);
}
function fmtDocumento(doc) {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return d;
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

async function carregarLoja() {
  try {
    state.loja = await api('/api/painel/loja');
    const l = state.loja;
    $('#sideNome').textContent = l.nome || 'Minha loja';
    if (l.logo_url) { const img = $('#sideLogo'); img.src = l.logo_url; img.style.display = ''; }
    faviconDaLoja(l.logo_url, l.cor_primaria);
    $('#toggleAberta').checked = !!l.aberta_manual;
    $('#lblAberta').textContent = l.aberta_manual ? 'Loja aberta' : 'Loja fechada';
    const pausada = !!l.pausada || (l.pausada_ate && new Date(l.pausada_ate) > new Date());
    $('#btnReabrir').classList.toggle('hidden', !pausada);
    $('#btnPausar').classList.toggle('hidden', pausada);
    $('#pausaInfo').textContent = pausada ? ('Pausada' + (l.pausada_ate && dataServidor(l.pausada_ate) ? ' até ' + dataServidor(l.pausada_ate).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' }) : '')) : '';
  } catch { /* silencioso */ }
}
$('#toggleAberta').addEventListener('change', async (e) => {
  try {
    await api('/api/painel/loja', { method: 'PATCH', body: { aberta_manual: e.target.checked } });
    toast(e.target.checked ? 'Loja aberta para pedidos.' : 'Loja fechada. Nenhum pedido novo entra.');
    carregarLoja();
  } catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
});
$('#btnPausar').addEventListener('click', () => $('#pausarMenu').classList.toggle('hidden'));
$$('#pausarMenu button').forEach(b => b.addEventListener('click', async () => {
  $('#pausarMenu').classList.add('hidden');
  try {
    await api('/api/painel/loja/pausar', { method: 'POST', body: { minutos: Number(b.dataset.min) } });
    toast(`Loja pausada por ${b.dataset.min} minutos.`);
    carregarLoja();
  } catch (err) { toast(err.message, true); }
}));
document.addEventListener('click', (e) => {
  if (!e.target.closest('.pausar-wrap')) $('#pausarMenu').classList.add('hidden');
});
$('#btnReabrir').addEventListener('click', async () => {
  try { await api('/api/painel/loja/reabrir', { method: 'POST', body: {} }); toast('Loja reaberta.'); carregarLoja(); }
  catch (err) { toast(err.message, true); }
});

/* ---------- Configurações em caixas expansíveis (v1.11.1) ----------
   Os conectores (WhatsApp, Telegram, 99) e o backup viram acordeões:
   a página abre curta, com o status visível no cabeçalho de cada
   caixa, e o formulário só aparece quando o dono abre a caixa. */
function initAcordeoesConfig() {
  const forms = ['formCfgWhats', 'formCfgTelegram', 'formCfg99', 'formCfgIfood', 'formCfgBackup'];
  forms.forEach((id, idx) => {
    const form = document.getElementById(id);
    if (!form || form.dataset.acc) return;
    form.dataset.acc = '1';
    form.classList.add('acc-form');
    const head = form.firstElementChild;
    if (!head) return;
    head.classList.add('acc-head');
    const seta = document.createElement('span');
    seta.className = 'acc-seta';
    seta.innerHTML = '<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-chevron-right"></use></svg>';
    head.appendChild(seta);
    const body = document.createElement('div');
    body.className = 'acc-body';
    while (form.children.length > 1) body.appendChild(form.children[1]);
    form.appendChild(body);
    // Cada configuração é a SUA seção: todas nascem fechadas e abrir
    // uma fecha as outras — a página nunca vira uma lista extensa.
    form.classList.add('fechado');
    head.addEventListener('click', () => {
      const abrir = form.classList.contains('fechado');
      document.querySelectorAll('.acc-form').forEach((f) => f.classList.add('fechado'));
      if (abrir) form.classList.remove('fechado');
    });
  });
}

/* ---------- Tempo real (SSE + fallback polling) ---------- */
function conectarStream() {
  if (state.sse) state.sse.close();
  try {
    const es = new EventSource('/api/painel/stream?token=' + encodeURIComponent(state.token));
    state.sse = es;
    const aoEvento = () => { carregarPedidos(true); carregarLoja(); };
    es.addEventListener('pedido', aoEvento);
    es.addEventListener('loja', aoEvento);
    es.onmessage = aoEvento;
    es.onerror = () => { /* polling cobre */ };
  } catch { /* polling cobre */ }
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => { if (state.view === 'pedidos') carregarPedidos(true); }, 10000);
}

/* ---------- Som de alerta de novo pedido ---------- */
let audioArquivo = null;
function somSelecionado() { return (state.loja && state.loja.som_pedido) || 'padrao'; }
function bip() {
  try {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = state.audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    [880, 1174, 1568].forEach((freq, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = freq; o.type = 'triangle';
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.55, ctx.currentTime + i * 0.16 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.16 + 0.15);
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.16); o.stop(ctx.currentTime + i * 0.16 + 0.17);
    });
  } catch { /* sem áudio */ }
}
function tocarToque(sel, emLoop) {
  if (!sel || sel === 'padrao') { bip(); return; }
  if (!audioArquivo) audioArquivo = new Audio();
  const src = '/sons/' + sel;
  if (audioArquivo.dataset.src !== src) { audioArquivo.src = src; audioArquivo.dataset.src = src; }
  audioArquivo.loop = !!emLoop;
  audioArquivo.volume = 1;
  try { audioArquivo.currentTime = 0; } catch { /* início */ }
  audioArquivo.play().catch(() => { /* navegador libera após 1ª interação */ });
}
function atualizarSom() {
  const temNovo = state.pedidos.some(p => p.status === 'NOVO');
  if (temNovo && !state.somAtivo) {
    state.somAtivo = true;
    const sel = somSelecionado();
    if (sel && sel !== 'padrao') tocarToque(sel, true);
    else { bip(); state.somTimer = setInterval(bip, 2500); }
  } else if (!temNovo) pararSom();
}
function pararSom() {
  state.somAtivo = false;
  if (state.somTimer) { clearInterval(state.somTimer); state.somTimer = null; }
  if (audioArquivo) { try { audioArquivo.pause(); audioArquivo.currentTime = 0; } catch { /* ok */ } }
}
document.addEventListener('pointerdown', () => { if (state.somAtivo) pararSom(); });

/* v1.9.12: som no celular — o navegador movel so libera audio depois de um
   gesto do usuario. No PRIMEIRO toque/clique/tecla: criamos e retomamos o
   AudioContext e preparamos (play+pause silencioso) cada elemento de audio;
   dai em diante os alertas tocam sozinhos. Ao voltar pra aba, retoma o
   contexto caso o navegador o tenha suspendido. */
let audioDestravado = false;
function primarAudio(el) {
  if (!el) return;
  try {
    el.volume = 0;
    const p = el.play();
    const fim = () => { try { el.pause(); el.currentTime = 0; el.volume = 1; } catch { /* ok */ } };
    if (p && p.then) p.then(fim).catch(() => { el.volume = 1; });
    else fim();
  } catch { /* sem audio */ }
}
function destravarAudio() {
  if (audioDestravado) return;
  audioDestravado = true;
  try {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
  } catch { /* sem audio */ }
  const sel = somSelecionado();
  if (sel && sel !== 'padrao') {
    if (!audioArquivo) { audioArquivo = new Audio(); audioArquivo.dataset.src = '/sons/' + sel; audioArquivo.src = '/sons/' + sel; }
    primarAudio(audioArquivo);
  }
  if (!audioDinheiro) audioDinheiro = new Audio('/sons/money-soundfx.mp3');
  primarAudio(audioDinheiro);
  primarAudio($('#alertaAudio'));
}
document.addEventListener('pointerdown', destravarAudio);
document.addEventListener('keydown', destravarAudio);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.audioCtx && state.audioCtx.state === 'suspended') state.audioCtx.resume();
});

/* ================= PEDIDOS ================= */
const FORMA_ROTULO = { pix:'Pix', dinheiro:'Dinheiro', cartao:'Cartão', pix_mp:'Pix MP', cartao_mp:'Cartão MP', pix_asaas:'Pix Asaas', cartao_asaas:'Cartão Asaas' };
const STATUS_ROTULO = { NOVO:'Novo', EM_PREPARO:'Em preparo', PRONTO:'Pronto', SAIU_ENTREGA:'Saiu p/ entrega', ENTREGUE:'Entregue', CANCELADO:'Cancelado' };
const COLUNAS = [
  { titulo:'Novos', status:['NOVO'] },
  { titulo:'Em preparo', status:['EM_PREPARO'] },
  { titulo:'Prontos', status:['PRONTO'] },
  { titulo:'Saiu p/ entrega', status:['SAIU_ENTREGA'] },
  { titulo:'Finalizados hoje', status:['ENTREGUE','CANCELADO'] },
];
function nomeItem(it) { return it.nome || it.nome_snapshot || it.produto_nome || 'Item'; }
function nomeOpcao(op) { return op.nome || op.opcao_nome || op.nome_snapshot || ''; }
function grupoOpcao(op) { return op.grupo_nome || op.grupo || ''; }
function seloPagamento(p) {
  const st = p.pagamento_status;
  if (st === 'pendente') return '<span class="selo pag-pendente">aguardando pagamento</span>';
  if (st === 'pago') return '<span class="selo pag-pago">pago</span>';
  if (st === 'falhou') return '<span class="selo pag-falhou">pagamento falhou</span>';
  if (st === 'erro_config') return '<span class="selo pag-falhou">pagamento não gerado</span>';
  if (st === 'estornado') return '<span class="selo pag-falhou">estornado</span>';
  return '';
}
function selosPedido(p) {
  return `<span class="selo ${p.tipo === 'entrega' ? 'entrega' : 'retirada'}">${p.tipo === 'entrega' ? 'ENTREGA' : 'RETIRADA'}</span>`
    + `<span class="selo">${esc(FORMA_ROTULO[p.forma_pagamento] || p.forma_pagamento || '')}</span>`
    + seloPagamento(p);
}
function minutosDesde(iso) {
  const d = dataServidor(iso) || new Date();
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
}
function classeTempo(min) { return min > 20 ? 'danger' : min > 10 ? 'warn' : ''; }
function resumoItens(p) {
  if (Array.isArray(p.itens)) return p.itens.map(it => `${it.quantidade || 1}x ${nomeItem(it)}`).join('\n');
  return p.itens_resumo || p.resumo || '';
}
async function carregarPedidos(silencioso = false) {
  try {
    const data = await api('/api/painel/pedidos');
    state.pedidos = Array.isArray(data) ? data : (data.pedidos || []);
    renderBoard();
    atualizarSom();
    const novos = state.pedidos.filter(p => p.status === 'NOVO').length;
    const badge = $('#badgeNovos');
    badge.textContent = String(novos); badge.classList.toggle('hidden', novos === 0);
    document.title = (novos ? `(${novos}) ` : '') + 'Painel — Açaí do Guri';
    if (state.detalheId) abrirDetalhe(state.detalheId, true);
  } catch (err) { if (!silencioso) toast(err.message, true); }
}
function renderBoard() {
  const soAguard = $('#filtroAguardando').checked;
  const lista = state.pedidos.filter(p => !soAguard || p.pagamento_status === 'pendente');
  $('#board').innerHTML = COLUNAS.map(col => {
    const itens = lista.filter(p => col.status.includes(p.status));
    return `<div class="coluna"><h4>${col.titulo} <span class="qtd">${itens.length}</span></h4>` +
      (itens.map(p => {
        const min = minutosDesde(p.created_at || p.criado_em);
        const ativo = !['ENTREGUE','CANCELADO'].includes(p.status);
        return `<article class="pcard ${p.status === 'NOVO' ? 'novo' : ''}" data-id="${p.id}">
          <div class="pcard-top"><span class="pcard-num">#${p.numero}</span>
          ${ativo ? `<span class="pcard-tempo ${classeTempo(min)}">${min} min</span>` : `<span class="pcard-tempo">${STATUS_ROTULO[p.status]}</span>`}</div>
          <div class="pcard-cliente">${esc(p.cliente_nome || 'Cliente')}</div>
          <div class="pcard-itens">${esc(resumoItens(p))}</div>
          ${p.codigo_entrega && ativo ? `<div class="pcard-pin">${ic('chave')} PIN ${esc(p.codigo_entrega)}</div>` : ''}
          ${p.origem === 'ifood' ? '<div class="pcard-ifood">iFood</div>' : ''}
          <div class="pcard-bottom"><span class="pcard-total">${fmtBRL(p.total_centavos)}</span><span class="selos">${selosPedido(p)}</span></div>
        </article>`;
      }).join('') || '<div class="dica" style="text-align:center;padding:.6rem">—</div>') + '</div>';
  }).join('');
  $$('#board .pcard').forEach(c => c.addEventListener('click', () => abrirDetalhe(c.dataset.id)));
  $('#pedidosVazio').classList.toggle('hidden', state.pedidos.length > 0);
  $('#pedidosInfo').textContent = state.pedidos.length ? `${state.pedidos.length} pedido(s) hoje` : '';
}
$('#filtroAguardando').addEventListener('change', renderBoard);
$('#btnAtualizarPedidos').addEventListener('click', () => carregarPedidos());
setInterval(() => { if (state.view === 'pedidos' && state.pedidos.length) renderBoard(); }, 30000);

/* ---------- Detalhe do pedido ---------- */
const TRANSICOES = {
  NOVO: [ { para:'EM_PREPARO', rotulo:'Confirmar pedido', cls:'btn-ok' }, { para:'CANCELADO', rotulo:'Cancelar', cls:'btn-danger', motivo:true } ],
  EM_PREPARO: [ { para:'PRONTO', rotulo:'Marcar pronto', cls:'btn-ok' }, { para:'CANCELADO', rotulo:'Cancelar', cls:'btn-danger', motivo:true } ],
  PRONTO: [], // montado conforme o tipo (entrega/retirada)
  SAIU_ENTREGA: [ { para:'ENTREGUE', rotulo:'Marcar entregue', cls:'btn-ok' } ],
  ENTREGUE: [], CANCELADO: [],
};
function transicoesDo(p) {
  if (p.status === 'PRONTO') {
    const arr = [];
    if (p.tipo === 'entrega') arr.push({ para:'SAIU_ENTREGA', rotulo:'Saiu para entrega', cls:'btn-primary' });
    arr.push({ para:'ENTREGUE', rotulo:'Marcar entregue', cls:'btn-ok' });
    return arr;
  }
  return TRANSICOES[p.status] || [];
}
function enderecoTexto(p) {
  const e = p.endereco;
  if (!e) return p.endereco_texto || '';
  if (typeof e === 'string') { try { return enderecoTexto({ endereco: JSON.parse(e) }); } catch { return e; } }
  return [e.rua && `${e.rua}${e.numero ? ', ' + e.numero : ''}`, e.complemento, p.bairro || e.bairro].filter(Boolean).join(' — ');
}
async function abrirDetalhe(id, silencioso = false) {
  try {
    const p = await api('/api/painel/pedidos/' + id);
    let listaEntregas = [];
    try { listaEntregas = await api('/api/painel/pedidos/' + id + '/entregas'); } catch { /* o detalhe abre mesmo sem o histórico de entregas */ }
    state.detalheId = id;
    $('#drawerTitulo').textContent = `Pedido #${p.numero} — ${STATUS_ROTULO[p.status] || p.status}`;
    const itens = (p.itens || []).map(it => `
      <div class="det-item">
        <div class="det-item-top"><span>${it.quantidade || 1}x ${esc(nomeItem(it))}</span><span>${fmtBRL(it.subtotal_centavos ?? ((it.preco_unitario_centavos || 0) * (it.quantidade || 1)))}</span></div>
        ${(it.opcoes && it.opcoes.length) ? `<div class="det-opcoes">${it.opcoes.map(op => `• ${grupoOpcao(op) ? esc(grupoOpcao(op)) + ': ' : ''}${esc(nomeOpcao(op))}${op.preco_adicional_centavos ? ' (+' + fmtBRL(op.preco_adicional_centavos) + ')' : ''}`).join('<br>')}</div>` : ''}
        ${it.observacao ? `<div class="det-obs">${ic('alerta')} OBS: ${esc(it.observacao)}</div>` : ''}
      </div>`).join('');
    const end = enderecoTexto(p);
    const ref = (p.endereco && typeof p.endereco === 'object' && p.endereco.referencia) || p.referencia || '';
    const troco = (p.forma_pagamento === 'dinheiro' && p.troco_para_centavos && Number(p.troco_para_centavos) > Number(p.total_centavos))
      ? `<div class="troco-box">${ic('dinheiro')} Troco: ${fmtBRL(Number(p.troco_para_centavos) - Number(p.total_centavos))} (cliente deu ${fmtBRL(p.troco_para_centavos)})</div>` : '';
    // Linha do tempo (v1.9.1): cada passo mostra O QUÊ, QUEM, QUANDO e
    // POR ONDE — "Entregue — Maria Silva — 14:32 (painel)". Linhas antigas
    // (sem autor gravado) mostram só o passo, a hora e o canal.
    const hist = (p.historico || []).map(h => {
      const dh = dataServidor(h.created_at || h.criado_em);
      const hora = dh ? dh.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
      const autorTxt = h.autor ? ' — ' + esc(h.autor) : '';
      const canal = h.origem && !(h.autor && /\(Telegram\)$/.test(h.autor)) ? ` (${esc(h.origem)})` : '';
      return `<div class="hist-item"><span><strong>${esc(STATUS_ROTULO[h.para_status] || h.para_status || '')}</strong>${autorTxt}${hora ? ' — ' + hora : ''}${canal}${h.motivo ? ' · ' + esc(h.motivo) : ''}</span></div>`;
    }).join('');
    const notifs = (p.notificacoes || []).map(n => `
      <div class="notif-item"><span>${esc(n.template || n.tipo || 'mensagem')} → ${esc(n.destino || '')}</span><span class="notif-status">${esc(n.status || '')}${n.erro ? ' (' + esc(n.erro) + ')' : ''}</span></div>`).join('');
    const tel = String(p.cliente_whatsapp || '').replace(/\D/g, '');
    const acoes = transicoesDo(p).map((t, i) => `<button class="btn ${t.cls}" data-trans="${i}">${t.rotulo}</button>`).join('');
    const codigoBox = p.codigo_entrega
      ? `<div class="codigo-box"><span class="codigo-rot">${ic('chave')} Código de entrega</span><strong class="codigo-num">${esc(p.codigo_entrega)}</strong><span class="codigo-dica">Peça ao cliente na entrega${p.tipo === 'retirada' ? ' (no balcão)' : ''} — a baixa do pedido exige este código.</span></div>` : '';
    const podeDespachar99 = p.tipo === 'entrega' && ['EM_PREPARO', 'PRONTO'].includes(p.status);
    const entregasBox = p.tipo === 'entrega' ? `
      <div class="det-secao"><h5>Entrega 99</h5>
        ${listaEntregas.length ? listaEntregas.map(e => `
          <div class="entrega-item">
            <span><strong>${esc(e.status_rotulo || e.status)}</strong>${e.codigo_externo ? ` · cód. 99 ${esc(e.codigo_externo)}` : ''}${e.entregador ? ` · ${esc(e.entregador)}` : ''}${e.telefone ? ` (${esc(e.telefone)})` : ''}${e.preco_centavos ? ` · ${fmtBRL(e.preco_centavos)}` : ''}<br><span class="dica">${dataServidor(e.criado_em) ? dataServidor(e.criado_em).toLocaleString('pt-BR') : ''}${e.previsao ? ` · previsão ${esc(e.previsao)}` : ''}${e.motivo ? ` · ${esc(e.motivo)}` : ''}</span></span>
            ${e.codigo_externo && !['cancelado', 'entregue'].includes(e.status) ? `<span class="entrega-acoes"><button type="button" class="btn btn-ghost btn-sm" data-ent-consultar="${e.id}">Consultar</button> <button type="button" class="btn btn-ghost btn-sm" data-ent-cancelar="${e.id}">Cancelar entrega</button></span>` : ''}
          </div>`).join('') : '<p class="dica">Nenhum entregador chamado ainda.</p>'}
        ${podeDespachar99 ? `<button class="btn btn-primary" id="btnDespachar99">${ic('moto')} Despachar pela 99</button>` : ''}
      </div>` : '';
    $('#drawerBody').innerHTML = `
      <div class="det-secao"><span class="selos">${selosPedido(p)}</span>
        <span class="dica" style="margin-left:.4rem">${(dataServidor(p.created_at || p.criado_em) || new Date()).toLocaleString('pt-BR')}</span>
        ${p.atualizado_por ? `<div class="dica" style="margin-top:.3rem">Última atualização por <strong>${esc(p.atualizado_por)}</strong></div>` : ''}
        ${codigoBox}
      </div>
      <div class="det-secao"><h5>Itens</h5>${itens || '<p class="dica">Sem itens.</p>'}
        ${p.observacao ? `<div class="det-obs">${ic('alerta')} OBS do pedido: ${esc(p.observacao)}</div>` : ''}</div>
      <div class="det-secao"><h5>Cliente</h5>
        <p><strong>${esc(p.cliente_nome || '')}</strong> — ${esc(p.cliente_whatsapp || '')}
        ${tel ? `<a class="wa-link" target="_blank" rel="noopener" href="https://wa.me/${tel}">${ic('chat')} Chamar no WhatsApp</a>` : ''}</p>
        ${p.tipo === 'entrega' ? `<p>${ic('pin')} ${esc(end)}${ref ? `<br>Referência: <strong>${esc(ref)}</strong>` : ''}${p.bairro ? `<br>Bairro: ${esc(p.bairro)}` : ''}</p>` : `<p>${ic('loja')} Retirada na loja</p>`}
      </div>
      ${entregasBox}
      <div class="det-secao"><h5>Pagamento</h5>
        <div class="det-totais">
          <div class="linha"><span>Subtotal</span><span>${fmtBRL(p.subtotal_centavos)}</span></div>
          <div class="linha"><span>Taxa de entrega</span><span>${fmtBRL(p.taxa_entrega_centavos)}</span></div>
          ${p.desconto_centavos ? `<div class="linha"><span>Desconto</span><span>− ${fmtBRL(p.desconto_centavos)}</span></div>` : ''}
          <div class="linha total"><span>Total (${esc(FORMA_ROTULO[p.forma_pagamento] || p.forma_pagamento || '')})</span><span>${fmtBRL(p.total_centavos)}</span></div>
        </div>
        ${p.pagamento_status && p.pagamento_status !== 'nao_aplicavel' ? `<p style="margin-top:.4rem">${seloPagamento(p)}</p>` : ''}
        ${troco}
      </div>
      <div class="det-acoes">${acoes}
        <button class="btn btn-ghost" id="btnImprimir">${ic('impressora')} Imprimir comanda</button>
      </div>
      ${hist ? `<div class="det-secao"><h5>Histórico</h5>${hist}</div>` : ''}
      ${notifs ? `<div class="det-secao"><h5>Notificações enviadas</h5>${notifs}</div>` : ''}`;
    $('#drawer').classList.remove('hidden');
    $('#drawerOverlay').classList.remove('hidden');
    $$('#drawerBody [data-trans]').forEach(btn => btn.addEventListener('click', () => {
      const t = transicoesDo(p)[Number(btn.dataset.trans)];
      if (t.motivo) pedirMotivoCancelamento(p);
      else if (t.para === 'ENTREGUE') pedirCodigoEntrega(p);
      else fazerTransicao(p.id, t.para);
    }));
    const b99 = $('#btnDespachar99');
    if (b99) b99.addEventListener('click', () => despacharEntrega99(p));
    $$('#drawerBody [data-ent-consultar]').forEach(b => b.addEventListener('click', () => acaoEntrega99('consultar', b.dataset.entConsultar, p)));
    $$('#drawerBody [data-ent-cancelar]').forEach(b => b.addEventListener('click', () => acaoEntrega99('cancelar', b.dataset.entCancelar, p)));
    $('#btnImprimir').addEventListener('click', () => imprimirComanda(p.id));
  } catch (err) { if (!silencioso) toast(err.message, true); }
}
function fecharDrawer() {
  state.detalheId = null;
  $('#drawer').classList.add('hidden');
  $('#drawerOverlay').classList.add('hidden');
}
$('#drawerFechar').addEventListener('click', fecharDrawer);
$('#drawerOverlay').addEventListener('click', fecharDrawer);

/* Som de dinheiro ao confirmar a entrega */
let audioDinheiro = null;
function tocarSomDinheiro() {
  try {
    if (!audioDinheiro) audioDinheiro = new Audio('/sons/money-soundfx.mp3');
    audioDinheiro.volume = 1;
    audioDinheiro.currentTime = 0;
    audioDinheiro.play().catch(() => { /* navegador libera após interação */ });
  } catch { /* sem áudio */ }
}
async function fazerTransicao(id, para, motivo, extra) {
  try {
    await api(`/api/painel/pedidos/${id}/transicao`, { method: 'POST', body: { para_status: para, motivo: motivo || undefined, ...(extra || {}) } });
    if (para === 'ENTREGUE') tocarSomDinheiro();
    toast(`Pedido atualizado: ${STATUS_ROTULO[para]}.`);
    carregarPedidos(true);
    abrirDetalhe(id, true);
  } catch (err) { toast(err.message, true); }
}
/* Baixa da entrega (v1.9): só com o código de entrega do cliente.
   Código errado = o servidor recusa e a mensagem aparece AQUI, sem fechar
   o diálogo. O admin ainda tem a saída "entregar sem código" (registrada
   no histórico); o funcionário, não. */
function pedirCodigoEntrega(p) {
  const ehAdmin = !state.user || state.user.perfil === 'admin';
  const body = openModal('Confirmar entrega — pedido #' + p.numero, `
    <form id="formCodigoEntrega">
      <p class="dica" style="margin-bottom:.6rem">Peça ao cliente o <strong>código de entrega de 4 dígitos</strong> (ele está na tela de acompanhamento do pedido e na comanda) e digite aqui:</p>
      <label>Código de entrega
        <input type="text" id="codigoEntregaInput" inputmode="numeric" autocomplete="off" maxlength="4" placeholder="0000" style="font-size:1.3rem;letter-spacing:.4em;text-align:center">
      </label>
      <div id="codigoEntregaErro" class="cfg-result erro hidden"></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="codigoVoltar">Voltar</button>
        ${ehAdmin ? '<button type="button" class="btn btn-ghost" id="codigoSemCodigo">Entregar sem código (admin)</button>' : ''}
        <button type="submit" class="btn btn-ok">Confirmar entrega</button>
      </div>
    </form>`);
  const input = $('#codigoEntregaInput', body);
  input.focus();
  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 4); });
  $('#codigoVoltar', body).addEventListener('click', closeModal);
  $('#formCodigoEntrega', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const erro = $('#codigoEntregaErro', body);
    erro.classList.add('hidden');
    const codigo = input.value.trim();
    try {
      await api(`/api/painel/pedidos/${p.id}/transicao`, { method: 'POST', body: { para_status: 'ENTREGUE', codigo_entrega: codigo } });
      closeModal();
      tocarSomDinheiro();
      toast('Pedido entregue — código conferido.');
      carregarPedidos(true);
      abrirDetalhe(p.id, true);
    } catch (err) {
      erro.textContent = err.message;
      erro.classList.remove('hidden');
      input.select();
    }
  });
  const btnSem = $('#codigoSemCodigo', body);
  if (btnSem) btnSem.addEventListener('click', async () => {
    if (!confirm('Entregar o pedido #' + p.numero + ' SEM conferir o código? Isso fica registrado no histórico do pedido.')) return;
    try {
      await api(`/api/painel/pedidos/${p.id}/transicao`, { method: 'POST', body: { para_status: 'ENTREGUE', sem_codigo: true } });
      closeModal();
      tocarSomDinheiro();
      toast('Pedido entregue sem código (registrado no histórico).');
      carregarPedidos(true);
      abrirDetalhe(p.id, true);
    } catch (err) { toast(err.message, true); }
  });
}
/* Entregador 99 (v1.9.2 — src/entregadores.js): com as credenciais ativas
   o servidor chama a API oficial; sem elas, registra o despacho manual com
   o PIN pronto pra copiar. Consultar/cancelar agem sobre a entrega salva
   no histórico do pedido — e falha na 99 nunca trava o pedido. */
async function despacharEntrega99(p) {
  try {
    const r = await api(`/api/painel/pedidos/${p.id}/entregas/despachar`, { method: 'POST', body: {} });
    carregarPedidos(true);
    await abrirDetalhe(p.id, true);
    if (r.modo === 'manual') { modalDespachoManual99(p, r.copia); toast('Despacho manual registrado no pedido.'); }
    else toast(`Entregador 99 chamado${r.entrega && r.entrega.codigo ? ' — código ' + r.entrega.codigo : ''}.`);
  } catch (err) { toast(err.message, true); }
}
async function acaoEntrega99(acao, entregaId, p) {
  try {
    const r = await api(`/api/painel/entregas/${entregaId}/${acao}`, { method: 'POST', body: {} });
    toast(acao === 'cancelar' ? 'Entrega cancelada na 99.' : `Status atualizado: ${(r.entrega && (r.entrega.status_rotulo || r.entrega.status)) || ''}.`);
    carregarPedidos(true);
    abrirDetalhe(p.id, true);
  } catch (err) { toast(err.message, true); }
}
function campoCopia(rotulo, valor) {
  return `<label>${esc(rotulo)}<span class="copy-row"><input type="text" value="${esc(valor || '')}" readonly><button type="button" class="btn btn-ghost btn-sm btn-copia-despacho">${ic('copiar')} Copiar</button></span></label>`;
}
function modalDespachoManual99(p, d) {
  d = d || {};
  const body = openModal('Despacho manual — 99 (pedido #' + p.numero + ')', `
    <p class="dica" style="margin-bottom:.6rem">As credenciais da 99 ainda não estão ativas (Configurações → Entregador 99). Copie os dados abaixo pro <strong>app da 99</strong> — o PIN é o código de entrega do pedido:</p>
    ${campoCopia('Endereço de coleta (loja)', d.coleta)}
    ${campoCopia('Endereço de destino (cliente)', d.destino)}
    ${campoCopia('Cliente', d.cliente)}
    ${campoCopia('Telefone do cliente', d.telefone)}
    ${campoCopia('PIN da entrega (= código de entrega)', d.pin)}
    ${campoCopia('Valor do pedido', d.total)}
    <p class="dica">O chamado ficou registrado como <strong>despacho manual</strong> no histórico da entrega (aqui no detalhe do pedido). Quando o entregador chegar, confira o PIN com o cliente normalmente.</p>`);
  $$('.btn-copia-despacho', body).forEach(b => b.addEventListener('click', async () => {
    const input = b.closest('.copy-row').querySelector('input');
    try { await navigator.clipboard.writeText(input.value); toast('Copiado.'); }
    catch { input.select(); document.execCommand('copy'); toast('Copiado.'); }
  }));
}
function pedirMotivoCancelamento(p) {
  const body = openModal('Cancelar pedido #' + p.numero, `
    <form id="formCancelar">
      <label>Motivo do cancelamento (o cliente recebe este aviso)
        <select id="cancelMotivo" required>
          <option value="">Selecione...</option>
          <option>Item sem estoque</option>
          <option>Endereço fora da área de entrega</option>
          <option>Cliente não respondeu</option>
          <option>Pedido suspeito (trote)</option>
          <option>Outro</option>
        </select>
      </label>
      <label>Detalhe (opcional) <input type="text" id="cancelDetalhe" placeholder="Ex.: acabou o morango"></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="cancelVoltar">Voltar</button>
        <button type="submit" class="btn btn-danger">Confirmar cancelamento</button>
      </div>
    </form>`);
  $('#cancelVoltar', body).addEventListener('click', closeModal);
  $('#formCancelar', body).addEventListener('submit', (ev) => {
    ev.preventDefault();
    const motivo = [$('#cancelMotivo', body).value, $('#cancelDetalhe', body).value].filter(Boolean).join(' — ');
    closeModal();
    fazerTransicao(p.id, 'CANCELADO', motivo);
  });
}
async function imprimirComanda(id) {
  try {
    const data = await api(`/api/painel/pedidos/${id}/imprimir`, { method: 'POST', body: {} });
    const w = window.open('', '_blank', 'width=420,height=640');
    if (!w) { toast('Permita pop-ups para ver a comanda.', true); return; }
    w.document.write(`<!DOCTYPE html><html><head><title>Comanda</title><style>body{font-family:'Courier New',monospace;font-size:13px;padding:10px}pre{white-space:pre-wrap}@media print{button{display:none}}</style></head><body><button onclick="window.print()">Imprimir</button><pre>${esc(data.comanda || '')}</pre></body></html>`);
    w.document.close();
    toast('Comanda gerada.');
  } catch (err) { toast(err.message, true); }
}

/* ================= CARDÁPIO ================= */
async function carregarCardapio() {
  try {
    const [cats, prods, grupos] = await Promise.all([
      api('/api/painel/categorias'), api('/api/painel/produtos'), api('/api/painel/grupos'),
    ]);
    state.categorias = Array.isArray(cats) ? cats : (cats.categorias || []);
    state.produtos = Array.isArray(prods) ? prods : (prods.produtos || []);
    state.grupos = Array.isArray(grupos) ? grupos : (grupos.grupos || []);
    renderCategorias(); renderProdutos();
  } catch (err) { toast(err.message, true); }
}
function nomeCategoria(id) {
  const c = state.categorias.find(x => String(x.id) === String(id));
  return c ? c.nome : '—';
}
function ativoDe(x) { return x.ativo === undefined ? true : !!x.ativo; }

function renderCategorias() {
  $('#categoriasList').innerHTML = state.categorias.map(c => `
    <span class="cat-chip ${ativoDe(c) ? '' : 'inativa'}">${esc(c.nome)}
      <button class="mini adm-only" data-cat-edit="${c.id}">Editar</button>
      <button class="mini adm-only" data-cat-del="${c.id}">${ativoDe(c) ? 'Inativar' : 'Reativar'}</button>
    </span>`).join('') || '<span class="dica">Nenhuma categoria ainda.</span>';
  $$('#categoriasList [data-cat-edit]').forEach(b => b.addEventListener('click', () => modalCategoria(state.categorias.find(c => String(c.id) === b.dataset.catEdit))));
  $$('#categoriasList [data-cat-del]').forEach(b => b.addEventListener('click', async () => {
    const c = state.categorias.find(x => String(x.id) === b.dataset.catDel);
    try {
      if (ativoDe(c)) { await api('/api/painel/categorias/' + c.id, { method: 'DELETE' }); toast('Categoria inativada.'); }
      else { await api('/api/painel/categorias/' + c.id, { method: 'PUT', body: { nome: c.nome, ordem: c.ordem, ativo: true } }); toast('Categoria reativada.'); }
      carregarCardapio();
    } catch (err) { toast(err.message, true); }
  }));
}
function modalCategoria(cat) {
  const edit = !!cat; cat = cat || { nome: '', ordem: 0, ativo: true };
  const body = openModal(edit ? 'Editar categoria' : 'Nova categoria', `
    <form id="formCat">
      <label>Nome <input type="text" id="catNome" value="${esc(cat.nome)}" required></label>
      <label>Ordem de exibição <input type="number" id="catOrdem" value="${cat.ordem || 0}"></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Salvar</button></div>
    </form>`);
  $('#formCat', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = { nome: $('#catNome', body).value.trim(), ordem: Number($('#catOrdem', body).value) || 0, ativo: ativoDe(cat) };
    try {
      if (edit) await api('/api/painel/categorias/' + cat.id, { method: 'PUT', body: payload });
      else await api('/api/painel/categorias', { method: 'POST', body: payload });
      closeModal(); toast('Categoria salva.'); carregarCardapio();
    } catch (err) { toast(err.message, true); }
  });
}
$('#btnNovaCategoria').addEventListener('click', () => modalCategoria(null));

function renderProdutos() {
  const busca = ($('#buscaProduto').value || '').toLowerCase();
  const lista = state.produtos.filter(p => !busca || (p.nome || '').toLowerCase().includes(busca));
  $('#produtosList').innerHTML = lista.map(p => `
    <div class="prod-row ${ativoDe(p) ? '' : 'inativo'}">
      <img src="${esc(p.foto_url || '')}" alt="" onerror="this.style.visibility='hidden'">
      <div class="prod-info">
        <div class="prod-nome">${esc(p.nome)}</div>
        <div class="prod-meta">${esc(nomeCategoria(p.categoria_id))} · ${p.tipo === 'montavel' ? 'montável' : 'simples'}${ativoDe(p) ? '' : ' · INATIVO'}</div>
      </div>
      ${p.destaque ? `<span class="tag destaque">${ic('estrela')} destaque</span>` : ''}
      ${p.tipo === 'montavel' ? '<span class="tag montavel">montável</span>' : ''}
      ${p.esgotado ? '<span class="tag esgotado">esgotado</span>' : ''}
      <span class="prod-preco">${fmtBRL(p.preco_base_centavos)}</span>
      <label class="chk" title="Marcar como esgotado (some do montador até desmarcar)"><input type="checkbox" data-prod-esgotado="${p.id}" ${p.esgotado ? 'checked' : ''}> Esgotado</label>
      <button class="btn btn-ghost btn-sm adm-only" data-prod-edit="${p.id}">Editar</button>
      <button class="btn btn-ghost btn-sm adm-only" data-prod-del="${p.id}">${ativoDe(p) ? 'Inativar' : 'Reativar'}</button>
    </div>`).join('') || '<p class="dica">Nenhum produto encontrado.</p>';
  $$('#produtosList [data-prod-edit]').forEach(b => b.addEventListener('click', () => modalProduto(state.produtos.find(p => String(p.id) === b.dataset.prodEdit))));
  $$('#produtosList [data-prod-del]').forEach(b => b.addEventListener('click', async () => {
    const p = state.produtos.find(x => String(x.id) === b.dataset.prodDel);
    try {
      if (ativoDe(p)) { await api('/api/painel/produtos/' + p.id, { method: 'DELETE' }); toast('Produto inativado (some da loja, histórico preservado).'); }
      else { await api('/api/painel/produtos/' + p.id, { method: 'PUT', body: { ...p, ativo: true } }); toast('Produto reativado.'); }
      carregarCardapio();
    } catch (err) { toast(err.message, true); }
  }));
  // Pausar por esgotado: liberado também pro funcionário (PUT só do toggle).
  $$('#produtosList [data-prod-esgotado]').forEach(chk => chk.addEventListener('change', async () => {
    const p = state.produtos.find(x => String(x.id) === chk.dataset.prodEsgotado);
    try {
      await api('/api/painel/produtos/' + p.id, { method: 'PUT', body: { esgotado: chk.checked } });
      toast(chk.checked ? `"${p.nome}" marcado como esgotado.` : `"${p.nome}" disponível de novo.`);
      carregarCardapio();
    } catch (err) { toast(err.message, true); chk.checked = !chk.checked; }
  }));
}
$('#buscaProduto').addEventListener('input', renderProdutos);
$('#btnNovoProduto').addEventListener('click', () => modalProduto(null));

function modalProduto(prod) {
  const edit = !!prod;
  prod = prod || { nome:'', descricao:'', categoria_id: state.categorias[0]?.id || '', tipo:'simples', preco_base_centavos:0, foto_url:'', destaque:false, esgotado:false, ativo:true, ordem:0, grupo_ids: [] };
  const vinculados = new Set((prod.grupo_ids || (prod.grupos || []).map(g => g.id) || []).map(String));
  const body = openModal(edit ? 'Editar produto' : 'Novo produto', `
    <form id="formProd">
      <div class="foto-edit">
        <img id="prodFotoPreview" src="${esc(prod.foto_url || '')}" alt="" onerror="this.style.opacity=.3">
        <div>
          <label class="btn btn-ghost btn-sm" style="margin:0">${ic('camera')} Enviar foto<input type="file" id="prodFotoFile" accept="image/*" hidden></label>
          <div class="dica" style="margin-top:.4rem">A foto aparece na página de pedidos.</div>
          <input type="hidden" id="prodFotoUrl" value="${esc(prod.foto_url || '')}">
        </div>
      </div>
      <label>Nome <input type="text" id="prodNome" value="${esc(prod.nome)}" required></label>
      <label>Descrição <textarea id="prodDesc" rows="2">${esc(prod.descricao || '')}</textarea></label>
      <div class="grid-2">
        <label>Categoria
          <select id="prodCategoria">${state.categorias.map(c => `<option value="${c.id}" ${String(c.id) === String(prod.categoria_id) ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select>
        </label>
        <label>Tipo
          <select id="prodTipo">
            <option value="simples" ${prod.tipo === 'simples' ? 'selected' : ''}>Simples (preço fechado)</option>
            <option value="montavel" ${prod.tipo === 'montavel' ? 'selected' : ''}>Montável (com grupos de opções)</option>
          </select>
        </label>
        <label>Preço base (R$) <input type="text" class="money" id="prodPreco" inputmode="numeric" placeholder="0,00"></label>
        <label>Ordem <input type="number" id="prodOrdem" value="${prod.ordem || 0}"></label>
      </div>
      <span style="font-size:.85rem;font-weight:600">Grupos de opções vinculados (produto montável)</span>
      <div class="grupos-checks">
        ${state.grupos.map(g => `<label class="chk"><input type="checkbox" class="prod-grupo" value="${g.id}" ${vinculados.has(String(g.id)) ? 'checked' : ''}> ${esc(g.nome)}</label>`).join('') || '<span class="dica">Nenhum grupo criado ainda — crie em "Grupos e Opções".</span>'}
      </div>
      <div class="form-row" style="display:flex;gap:1.2rem;flex-wrap:wrap">
        <label class="chk"><input type="checkbox" id="prodAtivo" ${ativoDe(prod) ? 'checked' : ''}> Ativo (visível na loja)</label>
        <label class="chk"><input type="checkbox" id="prodEsgotado" ${prod.esgotado ? 'checked' : ''}> Esgotado</label>
        <label class="chk"><input type="checkbox" id="prodDestaque" ${prod.destaque ? 'checked' : ''}> Destaque</label>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Salvar produto</button></div>
    </form>`);
  setMoney($('#prodPreco', body), prod.preco_base_centavos || 0);
  $('#prodFotoFile', body).addEventListener('change', async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    const local = URL.createObjectURL(f);
    $('#prodFotoPreview', body).src = local; $('#prodFotoPreview', body).style.opacity = 1;
    try {
      const url = await uploadArquivo(f);
      $('#prodFotoUrl', body).value = url;
      $('#prodFotoPreview', body).src = url;
      toast('Foto enviada.');
    } catch (err) { toast('Falha no upload: ' + err.message, true); }
  });
  $('#formProd', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = {
      nome: $('#prodNome', body).value.trim(),
      descricao: $('#prodDesc', body).value.trim(),
      categoria_id: $('#prodCategoria', body).value ? Number($('#prodCategoria', body).value) : null,
      tipo: $('#prodTipo', body).value,
      preco_base_centavos: getMoney($('#prodPreco', body)) || 0,
      foto_url: $('#prodFotoUrl', body).value || null,
      ordem: Number($('#prodOrdem', body).value) || 0,
      ativo: $('#prodAtivo', body).checked,
      esgotado: $('#prodEsgotado', body).checked,
      destaque: $('#prodDestaque', body).checked,
      grupo_ids: $$('.prod-grupo', body).filter(x => x.checked).map(x => Number(x.value)),
    };
    try {
      if (edit) await api('/api/painel/produtos/' + prod.id, { method: 'PUT', body: payload });
      else await api('/api/painel/produtos', { method: 'POST', body: payload });
      closeModal(); toast('Produto salvo.'); carregarCardapio();
    } catch (err) { toast(err.message, true); }
  });
}

/* ================= GRUPOS E OPÇÕES ================= */
async function carregarGrupos() {
  try {
    const [grupos, opcoes] = await Promise.all([api('/api/painel/grupos'), api('/api/painel/opcoes')]);
    state.grupos = Array.isArray(grupos) ? grupos : (grupos.grupos || []);
    const ops = Array.isArray(opcoes) ? opcoes : (opcoes.opcoes || []);
    state.opcoesPorGrupo = {};
    ops.forEach(o => { (state.opcoesPorGrupo[o.grupo_id] = state.opcoesPorGrupo[o.grupo_id] || []).push(o); });
    state.grupos.forEach(g => { if (g.opcoes && !state.opcoesPorGrupo[g.id]) state.opcoesPorGrupo[g.id] = g.opcoes; });
    renderGrupos();
  } catch (err) { toast(err.message, true); }
}
function renderGrupos() {
  $('#gruposList').innerHTML = state.grupos.map(g => {
    const ops = (state.opcoesPorGrupo[g.id] || []).slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
    return `<div class="grupo-card">
      <div class="grupo-head">
        <div>
          <div class="grupo-nome">${esc(g.nome)} ${ativoDe(g) ? '' : '<span class="tag esgotado">inativo</span>'}</div>
          <div class="grupo-meta">${g.tipo_escolha === 'unica' ? 'Escolha única' : 'Múltipla'} · mín ${g.minimo || 0}${g.maximo ? ' · máx ' + g.maximo : ' · sem limite'} · ${g.obrigatorio ? 'obrigatório' : 'opcional'}${g.excedente_vira_pago ? ` · excedente pago (${fmtBRL(g.preco_excedente_centavos)} cada)` : ''} · ordem ${g.ordem || 0}</div>
        </div>
        <div style="display:flex;gap:.4rem">
          <button class="btn btn-ghost btn-sm adm-only" data-grupo-edit="${g.id}">Editar grupo</button>
          <button class="btn btn-ghost btn-sm adm-only" data-grupo-del="${g.id}">${ativoDe(g) ? 'Inativar' : 'Reativar'}</button>
        </div>
      </div>
      <table class="opcoes-table">
        <thead><tr><th>Opção</th><th>Preço adicional</th><th>Ordem</th><th>Ativa</th><th>Esgotada</th><th></th></tr></thead>
        <tbody>
        ${ops.map(o => `<tr class="${(o.ativa === undefined ? true : !!o.ativa) ? '' : 'inativa'}">
          <td>${esc(o.nome)}</td>
          <td>${Number(o.preco_adicional_centavos) ? '+ ' + fmtBRL(o.preco_adicional_centavos) : 'incluso'}</td>
          <td>${o.ordem || 0}</td>
          <td><input type="checkbox" data-op-ativa="${o.id}" ${(o.ativa === undefined ? true : !!o.ativa) ? 'checked' : ''}></td>
          <td><input type="checkbox" data-op-esgotada="${o.id}" ${o.esgotada ? 'checked' : ''}></td>
          <td style="white-space:nowrap">
            <button class="btn btn-ghost btn-sm adm-only" data-op-edit="${o.id}">Editar</button>
            <button class="btn btn-ghost btn-sm adm-only" data-op-del="${o.id}">Inativar</button>
          </td></tr>`).join('') || '<tr><td colspan="6" class="dica">Nenhuma opção neste grupo ainda.</td></tr>'}
        </tbody>
      </table>
      <form class="add-opcao adm-only" data-add-opcao="${g.id}">
        <input type="text" name="nome" placeholder="Nova opção (ex.: Nutella)" required>
        <input type="text" name="preco" class="money" placeholder="Preço extra R$">
        <input type="number" name="ordem" placeholder="Ordem" value="0">
        <button class="btn btn-primary btn-sm" type="submit">+ Adicionar</button>
      </form>
    </div>`;
  }).join('') || '<p class="dica">Nenhum grupo criado ainda.</p>';
  $$('#gruposList .money').forEach(wireMoney);
  $$('#gruposList [data-grupo-edit]').forEach(b => b.addEventListener('click', () => modalGrupo(state.grupos.find(g => String(g.id) === b.dataset.grupoEdit))));
  $$('#gruposList [data-grupo-del]').forEach(b => b.addEventListener('click', async () => {
    const g = state.grupos.find(x => String(x.id) === b.dataset.grupoDel);
    try {
      if (ativoDe(g)) { await api('/api/painel/grupos/' + g.id, { method: 'DELETE' }); toast('Grupo inativado.'); }
      else { await api('/api/painel/grupos/' + g.id, { method: 'PUT', body: { ...g, ativo: true } }); toast('Grupo reativado.'); }
      carregarGrupos();
    } catch (err) { toast(err.message, true); }
  }));
  const todasOpcoes = () => Object.values(state.opcoesPorGrupo).flat();
  $$('#gruposList [data-op-edit]').forEach(b => b.addEventListener('click', () => modalOpcao(todasOpcoes().find(o => String(o.id) === b.dataset.opEdit))));
  $$('#gruposList [data-op-del]').forEach(b => b.addEventListener('click', async () => {
    try { await api('/api/painel/opcoes/' + b.dataset.opDel, { method: 'DELETE' }); toast('Opção inativada.'); carregarGrupos(); }
    catch (err) { toast(err.message, true); }
  }));
  $$('#gruposList [data-op-ativa]').forEach(chk => chk.addEventListener('change', async () => {
    const o = todasOpcoes().find(x => String(x.id) === chk.dataset.opAtiva);
    try { await api('/api/painel/opcoes/' + o.id, { method: 'PUT', body: { ...o, ativa: chk.checked } }); toast('Opção atualizada.'); }
    catch (err) { toast(err.message, true); chk.checked = !chk.checked; }
  }));
  $$('#gruposList [data-op-esgotada]').forEach(chk => chk.addEventListener('change', async () => {
    const o = todasOpcoes().find(x => String(x.id) === chk.dataset.opEsgotada);
    try { await api('/api/painel/opcoes/' + o.id, { method: 'PUT', body: { ...o, esgotada: chk.checked } }); toast(chk.checked ? 'Opção marcada como esgotada.' : 'Opção disponível de novo.'); carregarGrupos(); }
    catch (err) { toast(err.message, true); chk.checked = !chk.checked; }
  }));
  $$('#gruposList [data-add-opcao]').forEach(f => f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const gid = f.dataset.addOpcao;
    const precoInput = $('input[name="preco"]', f);
    try {
      await api('/api/painel/opcoes', { method: 'POST', body: {
        grupo_id: Number(gid), nome: $('input[name="nome"]', f).value.trim(),
        preco_adicional_centavos: getMoney(precoInput) || 0,
        ativa: true, esgotada: false, ordem: Number($('input[name="ordem"]', f).value) || 0,
      } });
      toast('Opção adicionada.'); carregarGrupos();
    } catch (err) { toast(err.message, true); }
  }));
}
function modalGrupo(g) {
  const edit = !!g;
  g = g || { nome:'', tipo_escolha:'multipla', minimo:0, maximo:null, obrigatorio:false, excedente_vira_pago:false, preco_excedente_centavos:0, ativo:true, ordem:0 };
  const body = openModal(edit ? 'Editar grupo' : 'Novo grupo', `
    <form id="formGrupo">
      <label>Nome do grupo <input type="text" id="grNome" value="${esc(g.nome)}" placeholder="Ex.: Tamanho, Acompanhamentos, Calda" required></label>
      <div class="grid-2">
        <label>Tipo de escolha
          <select id="grTipo">
            <option value="unica" ${g.tipo_escolha === 'unica' ? 'selected' : ''}>Única (radio)</option>
            <option value="multipla" ${g.tipo_escolha !== 'unica' ? 'selected' : ''}>Múltipla (checkbox)</option>
          </select>
        </label>
        <label>Ordem <input type="number" id="grOrdem" value="${g.ordem || 0}"></label>
        <label>Mínimo de escolhas <input type="number" id="grMin" min="0" value="${g.minimo || 0}"></label>
        <label>Máximo de escolhas <input type="number" id="grMax" min="0" value="${g.maximo ?? ''}" placeholder="Vazio = sem limite"></label>
      </div>
      <label>Preço do excedente (R$) <input type="text" class="money" id="grPrecoExc" inputmode="numeric" placeholder="0,00"></label>
      <div class="form-row" style="display:flex;gap:1.2rem;flex-wrap:wrap">
        <label class="chk"><input type="checkbox" id="grObrig" ${g.obrigatorio ? 'checked' : ''}> Obrigatório</label>
        <label class="chk"><input type="checkbox" id="grExcPago" ${g.excedente_vira_pago ? 'checked' : ''}> Excedente vira pago</label>
        <label class="chk"><input type="checkbox" id="grAtivo" ${ativoDe(g) ? 'checked' : ''}> Ativo</label>
      </div>
      <p class="dica">Ex.: "Acompanhamentos inclusos (até 3)": múltipla, máx 3, excedente pago desligado (trava em 3) — ou ligado com preço se quiser cobrar cada extra.</p>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Salvar grupo</button></div>
    </form>`);
  setMoney($('#grPrecoExc', body), g.preco_excedente_centavos || 0);
  $('#formGrupo', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const maxVal = $('#grMax', body).value;
    const payload = {
      nome: $('#grNome', body).value.trim(),
      tipo_escolha: $('#grTipo', body).value,
      minimo: Number($('#grMin', body).value) || 0,
      maximo: maxVal === '' ? null : Number(maxVal),
      obrigatorio: $('#grObrig', body).checked,
      excedente_vira_pago: $('#grExcPago', body).checked,
      preco_excedente_centavos: getMoney($('#grPrecoExc', body)) || 0,
      ativo: $('#grAtivo', body).checked,
      ordem: Number($('#grOrdem', body).value) || 0,
    };
    try {
      if (edit) await api('/api/painel/grupos/' + g.id, { method: 'PUT', body: payload });
      else await api('/api/painel/grupos', { method: 'POST', body: payload });
      closeModal(); toast('Grupo salvo.'); carregarGrupos();
    } catch (err) { toast(err.message, true); }
  });
}
$('#btnNovoGrupo').addEventListener('click', () => modalGrupo(null));

function modalOpcao(o) {
  if (!o) return;
  const body = openModal('Editar opção', `
    <form id="formOpcao">
      <label>Nome <input type="text" id="opNome" value="${esc(o.nome)}" required></label>
      <div class="grid-2">
        <label>Preço adicional (R$) <input type="text" class="money" id="opPreco" inputmode="numeric"></label>
        <label>Ordem <input type="number" id="opOrdem" value="${o.ordem || 0}"></label>
      </div>
      <div class="form-row" style="display:flex;gap:1.2rem">
        <label class="chk"><input type="checkbox" id="opAtiva" ${(o.ativa === undefined ? true : !!o.ativa) ? 'checked' : ''}> Ativa</label>
        <label class="chk"><input type="checkbox" id="opEsgotada" ${o.esgotada ? 'checked' : ''}> Esgotada</label>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Salvar opção</button></div>
    </form>`);
  setMoney($('#opPreco', body), o.preco_adicional_centavos || 0);
  $('#formOpcao', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/painel/opcoes/' + o.id, { method: 'PUT', body: {
        grupo_id: o.grupo_id, nome: $('#opNome', body).value.trim(),
        preco_adicional_centavos: getMoney($('#opPreco', body)) || 0,
        ordem: Number($('#opOrdem', body).value) || 0,
        ativa: $('#opAtiva', body).checked, esgotada: $('#opEsgotada', body).checked,
      } });
      closeModal(); toast('Opção salva.'); carregarGrupos();
    } catch (err) { toast(err.message, true); }
  });
}

/* ================= BAIRROS ================= */
async function carregarBairros() {
  try {
    const data = await api('/api/painel/bairros');
    state.bairros = Array.isArray(data) ? data : (data.bairros || []);
    $('#bairrosList').innerHTML = `
      <table class="simple-table"><thead><tr><th>Bairro</th><th>Taxa de entrega</th><th>Ativo</th><th></th></tr></thead>
      <tbody>${state.bairros.map(b => `<tr>
        <td>${esc(b.bairro)}</td><td>${fmtBRL(b.taxa_centavos)}</td>
        <td>${ativoDe(b) ? 'Sim' : 'Não'}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-ghost btn-sm adm-only" data-bairro-edit="${b.id}">Editar</button>
          <button class="btn btn-ghost btn-sm adm-only" data-bairro-del="${b.id}">${ativoDe(b) ? 'Inativar' : 'Reativar'}</button>
        </td></tr>`).join('') || '<tr><td colspan="4" class="dica">Nenhum bairro cadastrado.</td></tr>'}</tbody></table>`;
    $$('#bairrosList [data-bairro-edit]').forEach(x => x.addEventListener('click', () => modalBairro(state.bairros.find(b => String(b.id) === x.dataset.bairroEdit))));
    $$('#bairrosList [data-bairro-del]').forEach(x => x.addEventListener('click', async () => {
      const b = state.bairros.find(y => String(y.id) === x.dataset.bairroDel);
      try {
        if (ativoDe(b)) { await api('/api/painel/bairros/' + b.id, { method: 'DELETE' }); toast('Bairro inativado.'); }
        else { await api('/api/painel/bairros/' + b.id, { method: 'PUT', body: { bairro: b.bairro, taxa_centavos: b.taxa_centavos, ativo: true } }); toast('Bairro reativado.'); }
        carregarBairros();
      } catch (err) { toast(err.message, true); }
    }));
  } catch (err) { toast(err.message, true); }
}
function modalBairro(b) {
  const edit = !!b; b = b || { bairro: '', taxa_centavos: 0, ativo: true };
  const body = openModal(edit ? 'Editar bairro' : 'Novo bairro', `
    <form id="formBairro">
      <label>Bairro <input type="text" id="bNome" value="${esc(b.bairro)}" required></label>
      <label>Taxa de entrega (R$) <input type="text" class="money" id="bTaxa" inputmode="numeric"></label>
      <label class="chk"><input type="checkbox" id="bAtivo" ${ativoDe(b) ? 'checked' : ''}> Ativo (aparece no checkout)</label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Salvar</button></div>
    </form>`);
  setMoney($('#bTaxa', body), b.taxa_centavos || 0);
  $('#formBairro', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = { bairro: $('#bNome', body).value.trim(), taxa_centavos: getMoney($('#bTaxa', body)) || 0, ativo: $('#bAtivo', body).checked };
    try {
      if (edit) await api('/api/painel/bairros/' + b.id, { method: 'PUT', body: payload });
      else await api('/api/painel/bairros', { method: 'POST', body: payload });
      closeModal(); toast('Bairro salvo.'); carregarBairros();
    } catch (err) { toast(err.message, true); }
  });
}
$('#btnNovoBairro').addEventListener('click', () => modalBairro(null));

/* ================= MEIOS DE RECEBIMENTO ================= */
function normalizarRecebimentos(data) {
  const map = {};
  const arr = Array.isArray(data) ? data : (data && (data.recebimentos || data.meios)) || [];
  if (Array.isArray(arr)) arr.forEach(c => { if (c && c.meio) map[c.meio] = c; });
  else if (data && typeof data === 'object') Object.entries(data).forEach(([k, v]) => { if (v && typeof v === 'object') map[k] = v; });
  return map;
}
function credDe(cfg, campo) {
  if (!cfg) return '';
  const c = cfg.credenciais || cfg.credenciais_json || {};
  const v = typeof c === 'string' ? (() => { try { return JSON.parse(c)[campo] || ''; } catch { return ''; } })() : (c[campo] || '');
  return v || cfg[campo] || '';
}
function extraDe(cfg, campo) {
  if (!cfg) return undefined;
  const e = cfg.extra || cfg.extra_json || {};
  const obj = typeof e === 'string' ? (() => { try { return JSON.parse(e); } catch { return {}; } })() : e;
  return obj[campo];
}
function prepararCampoSegredo(input, mascaraAtual) {
  input.value = '';
  input.placeholder = mascaraAtual ? `Atual: ${mascaraAtual} — deixe vazio para manter` : 'Cole a credencial aqui';
  input.dataset.mascara = mascaraAtual || '';
}
async function carregarRecebimentos() {
  // URLs públicas dos webhooks (origem atual + caminho do contrato)
  $('#mpWebhookUrl').value = location.origin + '/api/webhooks/mercadopago';
  $('#asaasWebhookUrl').value = location.origin + '/api/webhooks/asaas';
  try {
    const data = await api('/api/painel/recebimentos');
    state.recebimentos = normalizarRecebimentos(data);
    const R = state.recebimentos;
    // Presencial
    const pix = R['pix_presencial'] || {};
    $('#pixPresAtivo').checked = !!pix.ativo;
    $('#pixPresChave').value = extraDe(pix, 'chave_pix') || pix.chave_pix || state.loja?.chave_pix || '';
    const cart = R['cartao_presencial'] || {};
    $('#cartaoPresAtivo').checked = !!cart.ativo;
    const din = R['dinheiro'] || {};
    $('#dinheiroAtivo').checked = !!din.ativo;
    $('#dinheiroTroco').checked = extraDe(din, 'aceita_troco') !== false;
    // Mercado Pago
    const mp = R['mercadopago'] || {};
    $('#mpAtivo').checked = !!mp.ativo;
    $('#mpAmbiente').value = mp.ambiente || 'sandbox';
    prepararCampoSegredo($('#mpAccessToken'), credDe(mp, 'access_token'));
    prepararCampoSegredo($('#mpPublicKey'), credDe(mp, 'public_key'));
    prepararCampoSegredo($('#mpWebhookSecret'), credDe(mp, 'webhook_secret'));
    // Asaas
    const as = R['asaas'] || {};
    $('#asaasAtivo').checked = !!as.ativo;
    $('#asaasAmbiente').value = as.ambiente || 'sandbox';
    prepararCampoSegredo($('#asaasApiKey'), credDe(as, 'api_key'));
    prepararCampoSegredo($('#asaasWebhookToken'), credDe(as, 'webhook_token'));
  } catch (err) { toast('Recebimentos: ' + err.message, true); }
}
async function salvarRecebimento(meio, payload) {
  await api('/api/painel/recebimentos/' + meio, { method: 'PATCH', body: payload });
  toast('Meio de recebimento salvo.');
  carregarRecebimentos();
}
$('#formPixPresencial').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await salvarRecebimento('pix_presencial', { ativo: $('#pixPresAtivo').checked, extra: { chave_pix: $('#pixPresChave').value.trim() } }); }
  catch (err) { toast(err.message, true); }
});
$('#formCartaoPresencial').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await salvarRecebimento('cartao_presencial', { ativo: $('#cartaoPresAtivo').checked }); }
  catch (err) { toast(err.message, true); }
});
$('#formDinheiro').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await salvarRecebimento('dinheiro', { ativo: $('#dinheiroAtivo').checked, extra: { aceita_troco: $('#dinheiroTroco').checked } }); }
  catch (err) { toast(err.message, true); }
});
$('#formMP').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cred = {};
  if ($('#mpAccessToken').value.trim()) cred.access_token = $('#mpAccessToken').value.trim();
  if ($('#mpPublicKey').value.trim()) cred.public_key = $('#mpPublicKey').value.trim();
  if ($('#mpWebhookSecret').value.trim()) cred.webhook_secret = $('#mpWebhookSecret').value.trim();
  try { await salvarRecebimento('mercadopago', { ativo: $('#mpAtivo').checked, ambiente: $('#mpAmbiente').value, credenciais: cred }); }
  catch (err) { toast(err.message, true); }
});
$('#formAsaas').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cred = {};
  if ($('#asaasApiKey').value.trim()) cred.api_key = $('#asaasApiKey').value.trim();
  if ($('#asaasWebhookToken').value.trim()) cred.webhook_token = $('#asaasWebhookToken').value.trim();
  try { await salvarRecebimento('asaas', { ativo: $('#asaasAtivo').checked, ambiente: $('#asaasAmbiente').value, credenciais: cred }); }
  catch (err) { toast(err.message, true); }
});
$$('[data-copy]').forEach(b => b.addEventListener('click', async () => {
  const input = document.getElementById(b.dataset.copy);
  try { await navigator.clipboard.writeText(input.value); toast('URL do webhook copiada.'); }
  catch { input.select(); document.execCommand('copy'); toast('URL do webhook copiada.'); }
}));
async function testarProvedor(meio, resultEl) {
  resultEl.textContent = 'Testando...'; resultEl.className = 'teste-result';
  try {
    const data = await api(`/api/painel/recebimentos/${meio}/testar`, { method: 'POST', body: {} });
    const ok = data.ok !== false && data.sucesso !== false;
    resultEl.textContent = ok ? (data.mensagem || 'Conexão OK') : (data.mensagem || data.erro || 'Falhou');
    resultEl.classList.add(ok ? 'ok' : 'erro');
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.classList.add('erro');
  }
}
$('#btnTestarMP').addEventListener('click', () => testarProvedor('mercadopago', $('#mpTesteResult')));
$('#btnTestarAsaas').addEventListener('click', () => testarProvedor('asaas', $('#asaasTesteResult')));

/* ================= LOJA E APARÊNCIA ================= */
function preencherLoja() {
  const l = state.loja;
  if (!l) { carregarLoja().then(preencherLoja); return; }
  $('#temaPrimaria').value = l.cor_primaria || '#7E047D';
  $('#temaDestaque').value = l.cor_destaque || '#DB04E2';
  temaPreviaAtualizar();
  $('#lojaNome').value = l.nome || '';
  $('#lojaWhatsapp').value = l.whatsapp || '';
  $('#lojaInstagram').value = l.instagram || '';
  $('#lojaEndereco').value = l.endereco_texto || '';
  $('#lojaDocumento').value = fmtDocumento(l.documento);
  $('#lojaTempoPreparo').value = l.tempo_preparo_min ?? '';
  $('#lojaTempoEntrega').value = l.tempo_entrega_min ?? '';
  setMoney($('#lojaPedidoMinimo'), l.pedido_minimo_centavos || 0);
  setMoney($('#lojaTaxaUnica'), l.taxa_unica_centavos);
  $('#lojaChavePix').value = l.chave_pix || '';
  $('#lojaAbre').value = l.horario_abre || '';
  $('#lojaFecha').value = l.horario_fecha || '';
  $('#lojaAbertaManual').checked = !!l.aberta_manual;
  $('#lojaSom').value = l.som_pedido || 'padrao';
  $('#lojaLogoUrl').value = l.logo_url || '';
  $('#lojaCapaUrl').value = l.capa_url || '';
  const lp = $('#logoPreview'); lp.src = l.logo_url || ''; lp.style.opacity = l.logo_url ? 1 : .3;
  const cp = $('#capaPreview'); cp.src = l.capa_url || ''; cp.style.opacity = l.capa_url ? 1 : .3;
}
async function uploadLojaImagem(file, hiddenId, previewId) {
  const preview = $(previewId);
  preview.src = URL.createObjectURL(file); preview.style.opacity = 1;
  try {
    const url = await uploadArquivo(file);
    $(hiddenId).value = url; preview.src = url;
    toast('Imagem enviada. Clique em "Salvar loja" para aplicar.');
  } catch (err) { toast('Falha no upload: ' + err.message, true); }
}
$('#btnTestarSom').addEventListener('click', () => { pararSom(); tocarToque($('#lojaSom').value, false); });
$('#fileLogo').addEventListener('change', (e) => { if (e.target.files[0]) uploadLojaImagem(e.target.files[0], '#lojaLogoUrl', '#logoPreview'); });
$('#fileCapa').addEventListener('change', (e) => { if (e.target.files[0]) uploadLojaImagem(e.target.files[0], '#lojaCapaUrl', '#capaPreview'); });
// Excluir logo/capa (v1.13.5): limpa o campo e a previa; aplica no "Salvar loja".
function excluirImagemLoja(hiddenId, previewId) {
  $(hiddenId).value = '';
  const p = $(previewId); p.src = ''; p.style.opacity = .3;
  toast('Imagem removida. Clique em "Salvar loja" para aplicar.');
}
$('#btnExcluirLogo').addEventListener('click', () => excluirImagemLoja('#lojaLogoUrl', '#logoPreview'));
$('#btnExcluirCapa').addEventListener('click', () => excluirImagemLoja('#lojaCapaUrl', '#capaPreview'));
$('#formLoja').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    nome: $('#lojaNome').value.trim(),
    whatsapp: $('#lojaWhatsapp').value.replace(/\D/g, ''),
    instagram: $('#lojaInstagram').value.trim(),
    endereco_texto: $('#lojaEndereco').value.trim(),
    documento: $('#lojaDocumento').value.replace(/\D/g, ''),
    tempo_preparo_min: Number($('#lojaTempoPreparo').value) || 0,
    tempo_entrega_min: Number($('#lojaTempoEntrega').value) || 0,
    pedido_minimo_centavos: getMoney($('#lojaPedidoMinimo')) || 0,
    taxa_unica_centavos: getMoney($('#lojaTaxaUnica')),
    chave_pix: $('#lojaChavePix').value.trim(),
    horario_abre: $('#lojaAbre').value || null,
    horario_fecha: $('#lojaFecha').value || null,
    aberta_manual: $('#lojaAbertaManual').checked,
    som_pedido: $('#lojaSom').value,
    cor_primaria: $('#temaPrimaria').value,
    cor_destaque: $('#temaDestaque').value,
    logo_url: $('#lojaLogoUrl').value || null,
    capa_url: $('#lojaCapaUrl').value || null,
  };
  try {
    await api('/api/painel/loja', { method: 'PATCH', body: payload });
    toast('Loja salva.');
    const lk = $('#temaCss'); if (lk) lk.href = '/tema.css?v=' + Date.now();
    carregarLoja();
  } catch (err) { toast(err.message, true); }
});

/* ================= PRIMEIROS PASSOS (v1.9.30) ================= */
let passosAtuais = [];
async function confirmarPasso(chave) {
  try {
    await api('/api/painel/primeiros-passos/confirmar', { method: 'POST', body: { chave } });
    carregarPassos();
  } catch (e) { toast(e.message, true); }
}
async function carregarPassos() {
  let p;
  try { p = await api('/api/painel/primeiros-passos'); } catch { return 0; }
  passosAtuais = [
    { feito: p.nome_ok, titulo: 'Dê um nome pra sua loja', desc: 'É o nome que o cliente vê no topo da loja e nas mensagens.', btn: 'Dar nome', view: 'loja' },
    { feito: p.logo_ok, titulo: 'Envie a logo da sua loja', desc: 'A arte que aparece na loja pública e no aplicativo do painel.', btn: 'Enviar logo', view: 'loja' },
    { feito: p.tema_ok, titulo: 'Escolha as cores — Tema do sistema', desc: 'A cara da sua marca: escolha um tema pronto ou monte o seu.', btn: 'Escolher cores', view: 'loja' },
    { feito: p.whatsapp_ok, titulo: 'Cadastre o WhatsApp da loja', desc: 'É por ele que os clientes chamam a sua loja.', btn: 'Cadastrar', view: 'loja' },
    { feito: p.endereco_ok, titulo: 'Informe o endereço da loja', desc: 'Aparece na loja pública e na comanda impressa.', btn: 'Informar', view: 'loja' },
    { feito: p.horario_ok, titulo: 'Confira o horário de funcionamento', desc: 'Fora do horário a loja fecha sozinha pros clientes. O padrão inicial é 09:00 às 18:00.', btn: 'Conferir horário', view: 'loja', confirmar: 'horario_ok', confRotulo: 'O horário está certo' },
    { feito: p.produtos_total > 0, titulo: 'Cadastre seu primeiro produto', desc: 'Crie as categorias e monte o seu cardápio do seu jeito.', btn: 'Cadastrar produto', view: 'cardapio' },
    { feito: p.entrega_ok, titulo: 'Defina como funciona a entrega', desc: 'Cadastre os bairros e as taxas — ou confirme que a taxa é combinada com cada cliente.', btn: 'Definir entrega', view: 'bairros', confirmar: 'taxa_ok', confRotulo: 'Minha taxa é combinada (a consultar)' },
    { feito: p.senha_ok, titulo: 'Troque a senha do administrador', desc: 'A senha inicial é a padrão de fábrica — troque antes de começar a vender.', btn: 'Trocar senha', acao: () => { const b = $('#btnTrocarSenha'); if (b) b.click(); } },
    { feito: p.aberta, titulo: 'Abra sua loja', desc: 'Tudo pronto? Abra pro público e comece a vender.', btn: 'Abrir a loja agora', acao: async () => { try { await api('/api/painel/loja', { method: 'PATCH', body: { aberta_manual: true } }); toast('Loja ABERTA! Bons pedidos.'); carregarLoja(); carregarPassos(); } catch (e) { toast(e.message, true); } } },
  ];
  const feitos = passosAtuais.filter((x) => x.feito).length;
  const cont = $('#passosContagem'); if (cont) cont.textContent = feitos + ' de ' + passosAtuais.length;
  const fill = $('#passosBarraFill'); if (fill) fill.style.width = Math.round((feitos / passosAtuais.length) * 100) + '%';
  const badge = $('#badgePassos');
  if (badge) { badge.textContent = String(passosAtuais.length - feitos); badge.classList.toggle('hidden', feitos === passosAtuais.length); }
  const pronto = $('#passosPronto'); if (pronto) pronto.classList.toggle('hidden', feitos !== passosAtuais.length);
  const lista = $('#passosLista');
  if (lista) {
    lista.innerHTML = passosAtuais.map((x, i) => `
      <div class="passo ${x.feito ? 'feito' : ''}">
        <span class="p-ic">${x.feito ? '<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-check"></use></svg>' : (i + 1)}</span>
        <div class="p-txt"><strong>${esc(x.titulo)}</strong><p>${esc(x.desc)}</p></div>
        <div class="p-acoes">
          ${x.feito ? '<span class="pill ok">Feito</span>' : `<button type="button" class="btn btn-primary btn-sm" data-passo="${i}">${esc(x.btn)}</button>`}
          ${!x.feito && x.confirmar ? `<button type="button" class="btn btn-ghost btn-sm" data-conf="${esc(x.confirmar)}">${esc(x.confRotulo)}</button>` : ''}
        </div>
      </div>`).join('');
    lista.querySelectorAll('[data-passo]').forEach((b) => b.addEventListener('click', () => {
      const x = passosAtuais[Number(b.dataset.passo)];
      if (!x) return;
      if (x.acao) x.acao(); else if (x.view) irPara(x.view);
    }));
    lista.querySelectorAll('[data-conf]').forEach((b) => b.addEventListener('click', () => confirmarPasso(b.dataset.conf)));
  }
  return feitos;
}
$('#btnPassosOcultar') && $('#btnPassosOcultar').addEventListener('click', () => confirmarPasso('ocultar'));
$('#btnPassosOcultar2') && $('#btnPassosOcultar2').addEventListener('click', () => { confirmarPasso('ocultar'); toast('Certo — a tela não abre mais sozinha. Ela fica no menu Primeiros Passos.'); });

/* ================= TEMA DO SISTEMA (v1.9.29) ================= */
const TEMA_PRESETS = [
  { nome: 'Roxo Açaí', primaria: '#7E047D', destaque: '#DB04E2' },
  { nome: 'Verde Folha', primaria: '#1E7A34', destaque: '#7AC74F' },
  { nome: 'Azul Confiança', primaria: '#1450A0', destaque: '#38B6E3' },
  { nome: 'Vermelho Sabor', primaria: '#B01E24', destaque: '#FF7A59' },
  { nome: 'Laranja Energia', primaria: '#D96C00', destaque: '#FFC53D' },
  { nome: 'Rosa Doce', primaria: '#C2438F', destaque: '#FF8FBF' },
  { nome: 'Marrom Café', primaria: '#6B4226', destaque: '#D9A441' },
  { nome: 'Preto Premium', primaria: '#232323', destaque: '#C9A227' },
];
function temaMistura(hex, alvo, peso) {
  const p = (x) => parseInt(x, 16);
  const c1 = [p(hex.slice(1, 3)), p(hex.slice(3, 5)), p(hex.slice(5, 7))];
  const c2 = [p(alvo.slice(1, 3)), p(alvo.slice(3, 5)), p(alvo.slice(5, 7))];
  const m = c1.map((v, i) => Math.round(v + (c2[i] - v) * peso));
  return '#' + m.map((v) => v.toString(16).padStart(2, '0')).join('');
}
function temaPreviaAtualizar() {
  const p = $('#temaPrimaria').value || '#7E047D';
  const pv = $('#temaPrevia');
  if (pv) {
    pv.style.setProperty('--primary', p);
    pv.style.setProperty('--deep', temaMistura(p, '#000000', 0.38));
    pv.style.setProperty('--bg', temaMistura(p, '#FFFFFF', 0.96));
  }
  document.querySelectorAll('.tema-chip').forEach((ch) => {
    ch.classList.toggle('sel', ch.dataset.primaria === p && ch.dataset.destaque === ($('#temaDestaque').value || ''));
  });
}
(function montarTema() {
  const box = $('#temaPresets');
  if (!box) return;
  box.innerHTML = TEMA_PRESETS.map((t) =>
    `<button type="button" class="tema-chip" data-primaria="${t.primaria}" data-destaque="${t.destaque}"><span class="bolas"><span class="bola" style="background:${t.primaria}"></span><span class="bola" style="background:${t.destaque}"></span></span>${t.nome}</button>`).join('');
  box.querySelectorAll('.tema-chip').forEach((ch) => ch.addEventListener('click', () => {
    $('#temaPrimaria').value = ch.dataset.primaria;
    $('#temaDestaque').value = ch.dataset.destaque;
    temaPreviaAtualizar();
  }));
  $('#temaPrimaria').addEventListener('input', temaPreviaAtualizar);
  $('#temaDestaque').addEventListener('input', temaPreviaAtualizar);
  $('#btnTemaPadrao').addEventListener('click', () => {
    $('#temaPrimaria').value = '#7E047D';
    $('#temaDestaque').value = '#DB04E2';
    temaPreviaAtualizar();
  });
})();

/* ================= RELATÓRIO ================= */
function hojeLocal() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtDataBR(iso) {
  if (!iso) return '';
  const [a, m, d] = String(iso).split('-');
  return (d && m && a) ? `${d}/${m}/${a}` : iso;
}
function comoLista(data, chave) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data[chave])) return data[chave];
  if (data && Array.isArray(data.itens)) return data.itens;
  return [];
}
async function carregarRelatorioDia() {
  if (!state.relData) state.relData = hojeLocal();
  const inp = $('#relData');
  if (inp && inp.value !== state.relData) inp.value = state.relData;
  try {
    const r = await api('/api/painel/relatorio?data=' + encodeURIComponent(state.relData));
    $('#relCards').innerHTML = `
      <div class="rel-card fin-vendas"><div class="num">${r.pedidos_concluidos ?? 0}</div><div class="rot">Pedidos concluídos</div></div>
      <div class="rel-card fin-despesas"><div class="num">${r.cancelados ?? 0}</div><div class="rot">Cancelados</div></div>
      <div class="rel-card fin-receitas"><div class="num">${fmtBRL(r.faturamento_centavos)}</div><div class="rot">Faturamento do dia</div></div>
      <div class="rel-card fin-insumos"><div class="num">${fmtBRL(r.ticket_medio_centavos)}</div><div class="rot">Ticket médio</div></div>`;
    const lista = (arr, vazio) => (arr && arr.length)
      ? arr.map(x => `<div class="rel-linha"><span>${esc(x.nome)}</span><strong>${x.qtd ?? x.quantidade ?? ''}</strong></div>`).join('')
      : `<p class="dica">${vazio}</p>`;
    $('#relTopProdutos').innerHTML = lista(r.top_produtos, 'Nenhuma venda concluída neste dia.');
    $('#relTopOpcoes').innerHTML = lista(r.top_opcoes, 'Nenhuma opção registrada neste dia.');
    const pp = r.por_pagamento || {};
    $('#relPorPagamento').innerHTML = Object.keys(pp).length
      ? Object.entries(pp).map(([k, v]) => `<div class="rel-linha"><span>${esc(FORMA_ROTULO[k] || k)}</span><strong>${typeof v === 'number' && v > 500 ? fmtBRL(v) : esc(v)}</strong></div>`).join('')
      : '<p class="dica">Sem pagamentos registrados neste dia.</p>';
  } catch (err) { toast(err.message, true); }
}
$('#relData').addEventListener('change', (e) => {
  state.relData = e.target.value || hojeLocal();
  carregarRelatorioDia();
});
$('#btnRelPdf').addEventListener('click', async () => {
  const data = state.relData || hojeLocal();
  const btn = $('#btnRelPdf');
  btn.disabled = true;
  try {
    const res = await fetch('/api/painel/relatorio/pdf?data=' + encodeURIComponent(data), {
      headers: state.token ? { 'Authorization': 'Bearer ' + state.token } : {},
    });
    if (res.status === 401) { sair(false); throw new Error('Sessão expirada. Entre de novo.'); }
    if (!res.ok) throw new Error('Não foi possível gerar o PDF (erro ' + res.status + ').');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'relatorio-' + data + '.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('PDF do relatório de ' + fmtDataBR(data) + ' salvo.');
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
});

/* ----- CONTÁBIL — Relatório MENSAL (v1.7; menu próprio na v1.7.1) ----- */
function mesAtualLocal() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function fmtMesBR(mes) { // 'YYYY-MM' -> 'MM/YYYY'
  const [a, m] = String(mes || '').split('-');
  return (m && a) ? `${m}/${a}` : mes;
}
async function carregarRelatorioMes() {
  if (!state.relMes) state.relMes = mesAtualLocal();
  const inp = $('#relMes');
  if (inp && inp.value !== state.relMes) inp.value = state.relMes;
  try {
    const r = await api('/api/painel/relatorio/mensal?mes=' + encodeURIComponent(state.relMes));
    const t = r.totais || {};
    const f = r.financeiro || {};
    const op = Number(f.lucro_operacional_centavos) || 0;
    $('#relMesCards').innerHTML = `
      <div class="rel-card fin-receitas"><div class="num">${fmtBRL(t.faturamento_centavos)}</div><div class="rot">Faturamento do mês</div></div>
      <div class="rel-card fin-vendas"><div class="num">${t.pedidos_concluidos ?? 0}</div><div class="rot">Pedidos concluídos</div></div>
      <div class="rel-card fin-despesas"><div class="num">${t.pedidos_cancelados ?? 0}</div><div class="rot">Cancelados</div></div>
      <div class="rel-card fin-insumos"><div class="num">${fmtBRL(t.ticket_medio_centavos)}</div><div class="rot">Ticket médio</div></div>
      <div class="rel-card fin-insumos"><div class="num">${fmtBRL(f.insumos_total)}</div><div class="rot"><span class="dot dot-azul"></span> Insumos</div></div>
      <div class="rel-card fin-despesas"><div class="num">${fmtBRL(f.despesas)}</div><div class="rot"><span class="dot dot-vermelho"></span> Despesas</div></div>
      <div class="rel-card fin-investimento"><div class="num">${fmtBRL(f.investimento_manual)}</div><div class="rot"><span class="dot dot-amarelo"></span> Investimento</div></div>
      <div class="rel-card ${op >= 0 ? 'lucro-pos' : 'lucro-neg'}"><div class="num">${fmtBRL(op)}</div><div class="rot">Lucro das vendas (operacional)</div></div>`;
    const real = Number(f.lucro_real) || 0;
    $('#relMesLucroCard').innerHTML = `
      <div class="fin-lucro ${real >= 0 ? 'pos' : 'neg'}">
        <div>
          <div class="rot">${real >= 0 ? ic('checkCirculo') : ic('alerta')} RESULTADO APÓS INVESTIMENTOS — ${fmtMesBR(state.relMes)}</div>
          <div class="num">${fmtBRL(real)}</div>
          <div class="sub">Lucro das vendas ${fmtBRL(op)} − investimento ${fmtBRL(f.investimento_manual)} · Receita acumulada ${fmtBRL(f.receita_total)} − custos ${fmtBRL(f.custo_total)}</div>
        </div>
        <div class="sub">${t.pedidos_concluidos ?? 0} pedido(s) concluído(s) no mês</div>
      </div>`;
    $('#relMesDias').innerHTML = (r.dias && r.dias.length)
      ? r.dias.map(d => `<div class="rel-linha"><span>${fmtDataBR(d.data)} — ${d.pedidos_concluidos} concluído(s) · ${d.pedidos_cancelados} cancelado(s) · ticket ${fmtBRL(d.ticket_medio_centavos)}</span><strong>${fmtBRL(d.faturamento_centavos)}</strong></div>`).join('')
      : '<p class="dica">Nenhum pedido neste mês.</p>';
    $('#relMesPorPagamento').innerHTML = (r.por_pagamento && r.por_pagamento.length)
      ? r.por_pagamento.map(p => `<div class="rel-linha"><span>${esc(FORMA_ROTULO[p.forma] || p.forma)} — ${p.qtd} pedido(s)</span><strong>${fmtBRL(p.total_centavos)}</strong></div>`).join('')
      : '<p class="dica">Sem pagamentos registrados neste mês.</p>';
  } catch (err) { toast(err.message, true); }
}
$('#relMes').addEventListener('change', (e) => {
  state.relMes = e.target.value || mesAtualLocal();
  carregarRelatorioMes();
});
// Download autenticado (mesmo padrão do PDF do dia: fetch + Bearer + blob).
async function baixarArquivoPainel(url, nome) {
  const res = await fetch(url, {
    headers: state.token ? { 'Authorization': 'Bearer ' + state.token } : {},
  });
  if (res.status === 401) { sair(false); throw new Error('Sessão expirada. Entre de novo.'); }
  if (!res.ok) throw new Error('Não foi possível gerar o arquivo (erro ' + res.status + ').');
  const blob = await res.blob();
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 4000);
}
$('#btnRelPdfMes').addEventListener('click', async (e) => {
  const mes = state.relMes || mesAtualLocal();
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await baixarArquivoPainel('/api/painel/relatorio/pdf?mes=' + encodeURIComponent(mes), 'relatorio-mensal-' + mes + '.pdf');
    toast('PDF do mês ' + fmtMesBR(mes) + ' salvo.');
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
});
$('#btnRelXml').addEventListener('click', async (e) => {
  const mes = state.relMes || mesAtualLocal();
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await baixarArquivoPainel('/api/painel/relatorio/mensal/xml?mes=' + encodeURIComponent(mes), 'relatorio-acai-' + mes + '.xml');
    toast('XML de ' + fmtMesBR(mes) + ' salvo — é só enviar pra contabilidade.');
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
});

/* ================= FINANCEIRO ================= */
const FIN_TIPO_ROTULO = { investimento: 'Investimento', receita_manual: 'Receita manual', despesa: 'Despesa' };

function finSyncDataInputs() {
  const d = state.finData;
  if ($('#finData').value !== d) $('#finData').value = d;
  if (!$('#finLancData').value || state.finEditandoId === null) $('#finLancData').value = d;
}
// ---------------- Fidelidade (v1.9.17) ----------------
function fidFone(w) {
  const d = String(w || '').replace(/\D/g, '').replace(/^55/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(w || '');
}
function fidDataFmt(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(' ', 'T'));
  return isNaN(d) ? '—' : d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function fidTipoMudou() { $('#fidTextoWrap').classList.toggle('hidden', $('#fidPremioTipo').value !== 'personalizado'); }
$('#fidPremioTipo').addEventListener('change', fidTipoMudou);

async function carregarFidelidade() {
  const r = await api('/api/painel/fidelidade');
  const c = r.config || {};
  $('#fidAtivo').checked = !!c.ativo;
  $('#fidMeta').value = c.meta_compras || 5;
  $('#fidPremioTipo').value = c.premio_tipo || 'entrega_gratis';
  $('#fidPremioTexto').value = c.premio_texto || '';
  fidTipoMudou();
  const meta = c.meta_compras || 5;
  const premios = r.premios || [];
  $('#fidPremios').innerHTML = premios.length ? `
    <table class="simple-table"><thead><tr><th>Cliente</th><th>Prêmio</th><th>Quando ganhou</th><th>Situação</th><th></th></tr></thead>
    <tbody>${premios.map(p => `<tr>
      <td><strong>${esc(p.cliente_nome || 'Cliente')}</strong><br><span class="dica">${esc(fidFone(p.whatsapp))} · ${p.marco_compras}ª compra</span></td>
      <td>${esc(p.premio_texto || '')}</td>
      <td>${fidDataFmt(p.criado_em)}</td>
      <td>${p.status === 'disponivel' ? '<span class="cfg-pill on">Aguardando resgate</span>'
        : `<span class="cfg-pill sim">Resgatado</span><br><span class="dica">${fidDataFmt(p.resgatado_em)}${p.pedido_resgate_id ? ' · pedido #' + p.pedido_resgate_id : ''}</span>`}</td>
      <td class="acoes-cell">${p.status === 'disponivel' ? `
        <button type="button" class="btn btn-primary btn-sm" data-fid-resgatar="${p.id}">Dar baixa (resgatou)</button>
        <button type="button" class="btn btn-ghost btn-sm" data-fid-remover="${p.id}">Remover</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>`
    : '<p class="dica">Nenhum prêmio ainda. Quando um cliente completar a meta, o prêmio aparece aqui.</p>';
  const rank = r.ranking || [];
  $('#fidRanking').innerHTML = rank.length ? `
    <table class="simple-table"><thead><tr><th>Cliente</th><th>Compras entregues</th><th>Faltam p/ prêmio</th></tr></thead>
    <tbody>${rank.map(x => {
      const resto = Number(x.compras) % meta;
      const faltam = resto === 0 ? 0 : meta - resto;
      return `<tr><td><strong>${esc(x.nome || 'Cliente')}</strong><br><span class="dica">${esc(fidFone(x.whatsapp))}</span></td>
      <td>${x.compras}</td><td>${faltam === 0 ? 'Ganhou! (ver prêmios)' : faltam}</td></tr>`;
    }).join('')}</tbody></table>`
    : '<p class="dica">Nenhuma compra entregue ainda.</p>';
  renderSorHistorico(r.sorteios || []);
  sorAtualizarPreview();
}
$('#formFidelidade').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/painel/fidelidade/config', {
    method: 'PUT',
    body: {
      ativo: $('#fidAtivo').checked,
      meta_compras: Number($('#fidMeta').value),
      premio_tipo: $('#fidPremioTipo').value,
      premio_texto: $('#fidPremioTexto').value.trim(),
    },
  });
  toast('Programa de fidelidade salvo.');
  carregarFidelidade();
});
document.addEventListener('click', async (e) => {
  const resg = e.target.closest('[data-fid-resgatar]');
  const rem = e.target.closest('[data-fid-remover]');
  if (resg) {
    await api(`/api/painel/fidelidade/premios/${resg.dataset.fidResgatar}/resgatar`, { method: 'POST', body: {} });
    toast('Prêmio marcado como resgatado.');
    carregarFidelidade();
  }
  if (rem) {
    if (!confirm('Remover este prêmio? O cliente perde o vale.')) return;
    await api(`/api/painel/fidelidade/premios/${rem.dataset.fidRemover}`, { method: 'DELETE' });
    toast('Prêmio removido.');
    carregarFidelidade();
  }
});

// ---------------- App do painel / PWA (v1.9.19) ----------------
// Instala o painel na tela inicial do celular (Android: prompt do navegador;
// iPhone: instrução manual, pois a Apple não oferece prompt). O service
// worker é rede-primeiro: com internet, o painel é SEMPRE o ao vivo.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/painel-sw.js', { scope: '/painel' }).catch(() => { /* sem SW, sem app — painel segue normal */ });
}
let promptInstalarApp = null;
const jaInstaladoApp = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  promptInstalarApp = e;
  if (!jaInstaladoApp) $('#btnInstalarApp').classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  promptInstalarApp = null;
  $('#btnInstalarApp').classList.add('hidden');
  toast('App do painel instalado! Ele está na sua tela inicial.');
});
const ehIOSPainel = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
if (ehIOSPainel && !jaInstaladoApp) $('#btnInstalarApp').classList.remove('hidden');
$('#btnInstalarApp').addEventListener('click', async () => {
  if (promptInstalarApp) {
    await promptInstalarApp.prompt();
    promptInstalarApp = null;
    $('#btnInstalarApp').classList.add('hidden');
  } else if (ehIOSPainel) {
    alert('Para instalar o app do painel:\n\n1. Toque no botão Compartilhar (o quadrado com a seta pra cima, na barra do Safari)\n2. Toque em "Adicionar à Tela de Início"\n3. Toque em "Adicionar"\n\nO painel vira um ícone na sua tela, igual a um app.');
  }
});

// Push do painel (v1.9.20): aviso de pedido novo na tela bloqueada.
// Ativação é POR APARELHO (cada celular/tablet ativa o seu). No iPhone, o
// PushManager só existe com o painel instalado (iOS 16.4+) — por isso o
// botão nem aparece onde não há suporte.
const pushSuportado = 'PushManager' in window && 'serviceWorker' in navigator && 'Notification' in window;
function vapidParaBytes(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function estadoBotaoPush() {
  const btn = $('#btnPush');
  if (!btn) return;
  if (!pushSuportado || !state.token) { btn.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  if (Notification.permission === 'denied') { $('#btnPushTxt').textContent = 'Notificações bloqueadas'; btn.dataset.ativo = ''; return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    btn.dataset.ativo = sub ? '1' : '';
    $('#btnPushTxt').textContent = sub ? 'Notificações ativas — testar' : 'Ativar notificações';
    // Renovação silenciosa: se já existe inscrição, regrava no servidor
    // (o endpoint pode ter mudado e o login pode ser de outro usuário).
    if (sub && Notification.permission === 'granted') {
      api('/api/painel/push/inscrever', { method: 'POST', body: { subscription: sub.toJSON() } }).catch(() => {});
    }
  } catch { /* sem SW pronto ainda; o clique tenta de novo */ }
}
$('#btnPush').addEventListener('click', async () => {
  if (!pushSuportado) return;
  if (Notification.permission === 'denied') {
    toast('As notificações estão bloqueadas neste navegador. Toque no cadeado/ícone na barra de endereço, libere as notificações e tente de novo.', true);
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && $('#btnPush').dataset.ativo === '1') {
    const r = await api('/api/painel/push/testar', { method: 'POST', body: {} }).catch((e) => ({ erro: e.message }));
    if (r && r.ok) toast('Notificação de teste enviada — olhe a tela do aparelho!');
    else toast((r && r.erro) || 'Falha ao enviar o teste.', true);
    return;
  }
  // v1.9.21: cada passo é nomeado — se algo falhar, o aviso diz ONDE (a
  // chave vem ANTES da permissão: erro de servidor aparece sem gastar o
  // pedido de permissão do navegador).
  let passo = 'buscar a chave no servidor';
  try {
    let chave = null;
    if (!sub) {
      const respChave = await api('/api/painel/push/chave');
      chave = respChave && respChave.chave;
      if (!chave) throw new Error('o servidor não devolveu a chave');
    }
    passo = 'pedir a sua permissão';
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Sem a sua permissão, o aviso não chega com a tela bloqueada.', true); return; }
    if (!sub) {
      passo = 'inscrever o aparelho no serviço de push';
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidParaBytes(chave) });
    }
    passo = 'salvar a inscrição no servidor';
    await api('/api/painel/push/inscrever', { method: 'POST', body: { subscription: sub.toJSON() } });
    toast('Notificações ativadas neste aparelho! Pedido novo agora apita até com a tela bloqueada.');
    estadoBotaoPush();
  } catch (e) {
    toast(`Não consegui ativar (passo: ${passo}): ${e.message || e} — endereço: ${location.origin}`, true);
  }
});

// ---------------- Sorteio de promoções (v1.9.18) ----------------
function sorFmtData(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function sorPeriodoDatas() {
  const tipo = $('#sorPeriodo').value;
  const hoje = new Date();
  if (tipo === 'tudo') return { ini: '', fim: '' };
  if (tipo === 'custom') return { ini: $('#sorIni').value || '', fim: $('#sorFim').value || '' };
  if (tipo === 'mes') return { ini: sorFmtData(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), fim: sorFmtData(hoje) };
  if (tipo === 'mes_passado') {
    return {
      ini: sorFmtData(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)),
      fim: sorFmtData(new Date(hoje.getFullYear(), hoje.getMonth(), 0)),
    };
  }
  const ini = new Date(hoje); ini.setDate(ini.getDate() - 29);
  return { ini: sorFmtData(ini), fim: sorFmtData(hoje) };
}
async function sorAtualizarPreview() {
  const { ini, fim } = sorPeriodoDatas();
  const qs = new URLSearchParams();
  if (ini) qs.set('ini', ini);
  if (fim) qs.set('fim', fim);
  try {
    const r = await api('/api/painel/fidelidade/sorteio/participantes' + (qs.toString() ? '?' + qs : ''));
    $('#sorPreview').textContent = r.clientes
      ? `${r.clientes} cliente(s) participam · ${r.chances} chance(s) no total (1 por compra entregue no período).`
      : 'Nenhum cliente com compra entregue neste período — ninguém participaria. Amplie o período.';
    $('#btnSortear').disabled = !r.clientes;
  } catch { $('#sorPreview').textContent = 'Não consegui conferir os participantes agora.'; }
}
$('#sorPeriodo').addEventListener('change', () => {
  const custom = $('#sorPeriodo').value === 'custom';
  $('#sorIniWrap').classList.toggle('hidden', !custom);
  $('#sorFimWrap').classList.toggle('hidden', !custom);
  sorAtualizarPreview();
});
$('#sorIni').addEventListener('change', sorAtualizarPreview);
$('#sorFim').addEventListener('change', sorAtualizarPreview);

function renderSorHistorico(lista) {
  const el = $('#sorHistorico');
  if (!lista || !lista.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<h4 style="margin:.9rem 0 .4rem">Sorteios já feitos</h4>
    <table class="simple-table"><thead><tr><th>Data</th><th>Sorteio</th><th>Prêmio</th><th>Participantes</th><th>Ganhador(a)</th><th></th></tr></thead>
    <tbody>${lista.map(s => {
      const msg = encodeURIComponent(`Oi, ${String(s.ganhador_nome || '').split(' ')[0]}! Aqui é da Açaí do Guri 🎉 Você ganhou o nosso sorteio "${s.titulo}": ${s.premio_texto}! Parabéns! É só fazer seu próximo pedido pelo site que o prêmio é seu.`);
      return `<tr>
      <td>${fidDataFmt(s.criado_em)}</td>
      <td><strong>${esc(s.titulo)}</strong></td>
      <td>${esc(s.premio_texto)}</td>
      <td>${s.total_clientes} cliente(s) · ${s.total_chances} chance(s)</td>
      <td><strong>${esc(s.ganhador_nome || 'Cliente')}</strong><br><span class="dica">${esc(fidFone(s.ganhador_whatsapp))} · tinha ${s.ganhador_chances} chance(s)</span></td>
      <td class="acoes-cell"><a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="https://wa.me/${String(s.ganhador_whatsapp || '').replace(/\D/g, '')}?text=${msg}">WhatsApp</a></td>
    </tr>`;
    }).join('')}</tbody></table>`;
}

$('#formSorteio').addEventListener('submit', async (e) => {
  e.preventDefault();
  const titulo = $('#sorTitulo').value.trim();
  const premio = $('#sorPremio').value.trim();
  if (!titulo) { toast('Dê um título ao sorteio.', true); return; }
  if (!premio) { toast('Escreva o prêmio do sorteio.', true); return; }
  if (!confirm(`Sortear agora "${titulo}"? O resultado fica registrado e o ganhador recebe o vale na hora.`)) return;
  const { ini, fim } = sorPeriodoDatas();
  $('#btnSortear').disabled = true;
  try {
    const r = await api('/api/painel/fidelidade/sorteios', { method: 'POST', body: { titulo, premio_texto: premio, ini: ini || null, fim: fim || null } });
    animarSorteio(r, titulo, premio);
    carregarFidelidade();
  } catch (err) {
    toast(err.message || 'Não consegui sortear.', true);
  } finally { $('#btnSortear').disabled = false; }
});

function animarSorteio(r, titulo, premio) {
  const modal = $('#sorteioModal');
  const nomeEl = $('#sorModalNome');
  const subEl = $('#sorModalSub');
  const acoes = $('#sorModalAcoes');
  $('#sorModalTitulo').textContent = titulo;
  subEl.textContent = `${r.total_clientes} participante(s) · ${r.total_chances} chance(s)`;
  acoes.classList.add('hidden');
  modal.classList.remove('hidden');
  // Lista de exibição ponderada (quem tem mais compras aparece mais).
  const exibicao = [];
  for (const p of r.participantes) for (let i = 0; i < Math.min(p.chances, 6); i++) exibicao.push(p.nome);
  if (!exibicao.length) exibicao.push(r.ganhador.nome);
  let atraso = 55;
  const girar = () => {
    nomeEl.textContent = exibicao[Math.floor(Math.random() * exibicao.length)];
    atraso *= 1.13;
    if (atraso < 480) setTimeout(girar, atraso);
    else {
      nomeEl.textContent = r.ganhador.nome;
      nomeEl.classList.add('sor-vencedor');
      $('#sorModalTitulo').textContent = 'Temos um(a) ganhador(a)!';
      subEl.innerHTML = `Prêmio: <strong>${esc(premio)}</strong> · o vale já está no nome dele(a) e você foi avisado no Telegram.`;
      const msg = encodeURIComponent(`Oi, ${String(r.ganhador.nome || '').split(' ')[0]}! Aqui é da Açaí do Guri 🎉 Você ganhou o nosso sorteio "${titulo}": ${premio}! Parabéns! É só fazer seu próximo pedido pelo site que o prêmio é seu.`);
      $('#sorModalZap').href = `https://wa.me/${String(r.ganhador.whatsapp || '').replace(/\D/g, '')}?text=${msg}`;
      acoes.classList.remove('hidden');
    }
  };
  nomeEl.classList.remove('sor-vencedor');
  girar();
}
$('#sorModalFechar').addEventListener('click', () => $('#sorteioModal').classList.add('hidden'));
$('#sorteioModal').addEventListener('click', (e) => { if (e.target.id === 'sorteioModal') e.target.classList.add('hidden'); });

async function carregarFinanceiro() {
  if (!state.finData) state.finData = hojeLocal();
  finSyncDataInputs();
  await Promise.all([carregarFinCalculo(false), carregarFinLancamentos(), carregarFinInsumos()]);
}
async function carregarFinCalculo(mostrarResultado = true) {
  try {
    const c = await api('/api/painel/financeiro/calculo?data=' + encodeURIComponent(state.finData));
    state.finCalculo = c;
    renderFinCards(c);
    if (mostrarResultado) renderFinResultado(c);
  } catch (err) { toast(err.message, true); }
}
function renderFinCards(c) {
  $('#finCards').innerHTML = `
    <div class="rel-card fin-vendas"><div class="num">${fmtBRL(c.vendas_sistema)}</div><div class="rot">Vendas do sistema (automático)</div></div>
    <div class="rel-card fin-receitas"><div class="num">${fmtBRL(c.receita_manual)}</div><div class="rot">Receitas manuais</div></div>
    <div class="rel-card destaque-card fin-acumulada"><div class="num">${fmtBRL(c.receita_total)}</div><div class="rot">Receita acumulada (vendas + manual)</div></div>
    <div class="rel-card fin-investimento"><div class="num">${fmtBRL(c.investimento_manual)}</div><div class="rot"><span class="dot dot-amarelo"></span> Investimento</div></div>
    <div class="rel-card fin-insumos"><div class="num">${fmtBRL(c.insumos_total)}</div><div class="rot"><span class="dot dot-azul"></span> Insumos</div></div>
    <div class="rel-card fin-despesas"><div class="num">${fmtBRL(c.despesas)}</div><div class="rot"><span class="dot dot-vermelho"></span> Despesas</div></div>`;
  const lucro = Number(c.lucro_real) || 0;
  const op = Number(c.lucro_operacional_centavos) || 0;
  $('#finLucroCard').innerHTML = `
    <div class="fin-lucro ${lucro >= 0 ? 'pos' : 'neg'}">
      <div>
        <div class="rot">${lucro >= 0 ? ic('checkCirculo') : ic('alerta')} LUCRO REAL DO DIA ${fmtDataBR(state.finData)}</div>
        <div class="num">${fmtBRL(lucro)}</div>
        <div class="sub">Receita acumulada ${fmtBRL(c.receita_total)} − custos ${fmtBRL(c.custo_total)} (investimento + insumos + despesas)</div>
      </div>
      <div class="sub">${c.pedidos_concluidos ?? 0} pedido(s) concluído(s) · ${c.copos ?? 0} copo(s)/item(ns) vendido(s)</div>
    </div>
    <div class="fin-lucro-op ${op >= 0 ? 'pos' : 'neg'}"><span>Lucro das vendas (operacional): <strong>${fmtBRL(op)}</strong></span><span class="sub">receita − insumos − despesas, <strong>sem</strong> contar o investimento — é o lucro da operação em si</span></div>`;
}
function renderFinResultado(c) {
  const box = $('#finResultado');
  box.classList.remove('hidden');
  const lucroCopo = Number(c.lucro_por_copo) || 0;
  $('#finResCustoCopo').textContent = fmtBRL(c.custo_por_copo);
  $('#finResPrecoCopo').textContent = fmtBRL(c.preco_medio_copo);
  const el = $('#finResLucroCopo');
  el.textContent = fmtBRL(lucroCopo);
  el.className = lucroCopo >= 0 ? 'pos' : 'neg';
  $('#finResLucroDia').textContent = fmtBRL(c.lucro_real);
  const linhas = [
    ['Copos/itens vendidos no dia', String(c.copos ?? 0)],
    ['Pedidos concluídos', String(c.pedidos_concluidos ?? 0)],
    ['Número de entregas', String(c.entregas ?? 0)],
    ['Taxas de entrega recebidas', fmtBRL(c.taxas_entrega)],
    ['Custo médio por entrega (despesas ÷ entregas)', fmtBRL(c.custo_medio_entrega)],
    ['Vendas do sistema', fmtBRL(c.vendas_sistema)],
    ['Receitas manuais', fmtBRL(c.receita_manual)],
    ['Custo total (investimento + insumos + despesas)', fmtBRL(c.custo_total)],
    ['Lucro das vendas (operacional, sem investimento)', fmtBRL(c.lucro_operacional_centavos)],
    ['Lucro real (após investimentos)', fmtBRL(c.lucro_real)],
  ];
  $('#finResDetalhe').innerHTML = linhas.map(([k, v]) => `<div class="rel-linha"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
}
$('#finData').addEventListener('change', (e) => {
  state.finData = e.target.value || hojeLocal();
  cancelarEdicaoLancamento();
  finSyncDataInputs();
  $('#finResultado').classList.add('hidden');
  carregarFinanceiro();
});

/* ----- Lançamentos ----- */
function finSelecionarTipo(tipo) {
  state.finTipoSel = tipo;
  $$('#finTipos .fin-chip').forEach(ch => ch.classList.toggle('sel', ch.dataset.tipo === tipo));
}
$$('#finTipos .fin-chip').forEach(ch => ch.addEventListener('click', () => finSelecionarTipo(ch.dataset.tipo)));

function cancelarEdicaoLancamento() {
  state.finEditandoId = null;
  $('#formLancamento').reset();
  setMoney($('#finLancValor'), null);
  $('#finLancData').value = state.finData || hojeLocal();
  finSelecionarTipo(state.finTipoSel);
  $('#btnSalvarLancamento').textContent = 'Adicionar lançamento';
  $('#btnCancelarEdicaoLanc').classList.add('hidden');
}
$('#btnCancelarEdicaoLanc').addEventListener('click', cancelarEdicaoLancamento);

$('#formLancamento').addEventListener('submit', async (e) => {
  e.preventDefault();
  const valor = getMoney($('#finLancValor'));
  if (!valor || valor <= 0) { toast('Informe um valor maior que zero.', true); return; }
  const payload = {
    tipo: state.finTipoSel,
    categoria: $('#finLancCategoria').value.trim(),
    descricao: $('#finLancDescricao').value.trim(),
    valor_centavos: valor,
    data: $('#finLancData').value || state.finData || hojeLocal(),
  };
  try {
    if (state.finEditandoId) {
      await api('/api/painel/financeiro/lancamentos/' + state.finEditandoId, { method: 'PUT', body: payload });
      toast('Lançamento atualizado.');
    } else {
      await api('/api/painel/financeiro/lancamentos', { method: 'POST', body: payload });
      toast('Lançamento adicionado.');
    }
    const editando = !!state.finEditandoId;
    cancelarEdicaoLancamento();
    if (payload.data !== state.finData && !editando) { state.finData = payload.data; }
    await carregarFinanceiro();
  } catch (err) { toast(err.message, true); }
});

async function carregarFinLancamentos() {
  try {
    const data = await api('/api/painel/financeiro/lancamentos?data=' + encodeURIComponent(state.finData));
    const lista = comoLista(data, 'lancamentos');
    const box = $('#finLancamentosList');
    if (!lista.length) {
      box.innerHTML = '<p class="dica">Nenhum lançamento neste dia. Adicione investimentos, receitas manuais e despesas no formulário acima.</p>';
      return;
    }
    box.innerHTML = `
      <table class="simple-table">
        <thead><tr><th>Tipo</th><th>Categoria</th><th>Descrição</th><th>Valor</th><th></th></tr></thead>
        <tbody>${lista.map(l => `
          <tr>
            <td><span class="fin-tipo ${esc(l.tipo)}">${esc(FIN_TIPO_ROTULO[l.tipo] || l.tipo)}</span></td>
            <td>${esc(l.categoria || '—')}</td>
            <td>${esc(l.descricao || '—')}</td>
            <td><strong>${fmtBRL(l.valor_centavos)}</strong></td>
            <td style="white-space:nowrap">
              <button class="btn btn-ghost btn-sm" data-fin-edit="${l.id}">Editar</button>
              <button class="btn btn-ghost btn-sm" data-fin-del="${l.id}">Excluir</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    $$('[data-fin-del]', box).forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Excluir este lançamento?')) return;
      try {
        await api('/api/painel/financeiro/lancamentos/' + b.dataset.finDel, { method: 'DELETE' });
        toast('Lançamento excluído.');
        if (String(state.finEditandoId) === String(b.dataset.finDel)) cancelarEdicaoLancamento();
        await carregarFinanceiro();
      } catch (err) { toast(err.message, true); }
    }));
    $$('[data-fin-edit]', box).forEach(b => b.addEventListener('click', () => {
      const l = lista.find(x => String(x.id) === String(b.dataset.finEdit));
      if (!l) return;
      state.finEditandoId = l.id;
      finSelecionarTipo(l.tipo);
      $('#finLancCategoria').value = l.categoria || '';
      $('#finLancDescricao').value = l.descricao || '';
      setMoney($('#finLancValor'), l.valor_centavos);
      $('#finLancData').value = l.data || state.finData;
      $('#btnSalvarLancamento').textContent = 'Salvar alterações';
      $('#btnCancelarEdicaoLanc').classList.remove('hidden');
      $('#formLancamento').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  } catch (err) { toast(err.message, true); }
}

/* ----- Insumos / Lucro por Venda ----- */
function fmtQtd(q) {
  const n = Number(q);
  if (!isFinite(n)) return esc(q ?? '');
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}
$('#formInsumo').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nome = $('#finInsumoNome').value.trim();
  const qtd = parseFloat($('#finInsumoQtd').value.replace(',', '.'));
  const custo = getMoney($('#finInsumoCusto'));
  if (!nome) { toast('Informe o nome do insumo.', true); return; }
  if (!isFinite(qtd) || qtd <= 0) { toast('Informe uma quantidade válida.', true); return; }
  if (!custo || custo <= 0) { toast('Informe o custo total do insumo.', true); return; }
  try {
    await api('/api/painel/financeiro/insumos', {
      method: 'POST',
      body: { nome, quantidade: qtd, unidade: $('#finInsumoUnidade').value.trim(), custo_total_centavos: custo, data: state.finData || hojeLocal() },
    });
    toast('Insumo adicionado.');
    e.target.reset();
    setMoney($('#finInsumoCusto'), null);
    await Promise.all([carregarFinInsumos(), carregarFinCalculo(false)]);
  } catch (err) { toast(err.message, true); }
});
async function carregarFinInsumos() {
  try {
    const data = await api('/api/painel/financeiro/insumos?data=' + encodeURIComponent(state.finData));
    const lista = comoLista(data, 'insumos');
    const box = $('#finInsumosList');
    if (!lista.length) {
      box.innerHTML = '<p class="dica">Nenhum insumo lançado neste dia. Ex.: Pote de açaí 5 kg — R$ 100,00 · Embalagens 100 un — R$ 50,00 · Morango 4 bandejas — R$ 25,00.</p>';
      return;
    }
    const total = lista.reduce((s, i) => s + (Number(i.custo_total_centavos) || 0), 0);
    box.innerHTML = `
      <table class="simple-table">
        <thead><tr><th>Insumo</th><th>Quantidade</th><th>Unidade</th><th>Custo total</th><th></th></tr></thead>
        <tbody>${lista.map(i => `
          <tr>
            <td>${esc(i.nome)}</td>
            <td>${fmtQtd(i.quantidade)}</td>
            <td>${esc(i.unidade || '—')}</td>
            <td><strong>${fmtBRL(i.custo_total_centavos)}</strong></td>
            <td><button class="btn btn-ghost btn-sm" data-ins-del="${i.id}">Excluir</button></td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr><td colspan="3"><strong>Total de insumos do dia</strong></td><td><strong>${fmtBRL(total)}</strong></td><td></td></tr></tfoot>
      </table>`;
    $$('[data-ins-del]', box).forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Excluir este insumo?')) return;
      try {
        await api('/api/painel/financeiro/insumos/' + b.dataset.insDel, { method: 'DELETE' });
        toast('Insumo excluído.');
        await Promise.all([carregarFinInsumos(), carregarFinCalculo(false)]);
      } catch (err) { toast(err.message, true); }
    }));
  } catch (err) { toast(err.message, true); }
}
$('#btnCalcularLucro').addEventListener('click', async () => {
  await carregarFinCalculo(true);
  const box = $('#finResultado');
  if (!box.classList.contains('hidden')) {
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('Lucro real calculado para ' + fmtDataBR(state.finData) + '.');
  }
});

/* ================= CONFIGURAÇÕES (WhatsApp + Telegram) ================= */
function cfgPill(el, configurado) {
  if (!el) return;
  el.textContent = configurado ? 'Configurado' : 'Não configurado';
  el.className = 'cfg-pill ' + (configurado ? 'on' : 'sim');
}
function cfgResultado(el, ok, mensagem) {
  if (!el) return;
  el.textContent = mensagem || (ok ? 'Tudo certo.' : 'Algo deu errado.');
  el.className = 'cfg-result ' + (ok ? 'ok' : 'erro');
}
function cfgPrepararSegredo(input, configurado, mascara, placeholderVazio) {
  input.value = '';
  input.type = 'password';
  input.placeholder = configurado
    ? `Salvo (${mascara || '••••'}) — deixe em branco para manter`
    : placeholderVazio;
}
function preencherConfiguracoes(c) {
  state.configuracoes = c;
  const w = (c && c.whatsapp) || {};
  cfgPill($('#cfgWhatsPill'), !!w.configurado);
  $('#cfgWhatsAtivo').checked = w.ativo === undefined ? true : !!w.ativo;
  $('#cfgWhatsUrl').value = w.evolution_url || '';
  $('#cfgWhatsInstancia').value = w.evolution_instancia || '';
  cfgPrepararSegredo($('#cfgWhatsApikey'), !!w.apikey_configurada, w.apikey_mascarada, 'Cole a chave de API aqui');
  $('#cfgWhatsApikeyDica').textContent = w.apikey_configurada
    ? `Chave salva (${w.apikey_mascarada || '••••'}). Deixe o campo em branco para manter a atual — preencha só se for trocar.`
    : 'Você encontra a chave no painel da Evolution API (apikey). Ela fica guardada só no servidor.';
  const t = (c && c.telegram) || {};
  cfgPill($('#cfgTgPill'), !!t.configurado);
  $('#cfgTgAtivo').checked = t.ativo === undefined ? true : !!t.ativo;
  cfgPrepararSegredo($('#cfgTgToken'), !!t.token_configurado, t.token_mascarado, 'Cole o token do bot aqui');
  $('#cfgTgTokenDica').textContent = t.token_configurado
    ? `Token salvo (${t.token_mascarado || '••••'}). Deixe o campo em branco para manter o atual — preencha só se for trocar.`
    : 'O token é a sequência longa que o @BotFather devolve quando o bot é criado. Ele fica guardado só no servidor.';
  $('#cfgTgChatId').value = t.chat_id || '';
  const wst = $('#cfgTgWebhookStatus');
  if (wst) wst.textContent = t.webhook_registrado ? 'Status: webhook REGISTRADO e protegido.' : 'Status: webhook ainda não registrado.';
  $$('[data-mostrar]').forEach(b => { b.innerHTML = ic('olho') + ' Mostrar'; b.dataset.mostrarEstado = 'oculto'; });
}
async function carregarConfiguracoes() {
  try {
    const c = await api('/api/painel/configuracoes');
    preencherConfiguracoes(c);
  } catch (err) { toast(err.message, true); }
  carregarCfg99(); // silencioso se falhar (a tela principal não depende dele)
  carregarCfgIfood();
}
/* Mostrar / ocultar os campos de segredo (chave de API e token) */
$$('[data-mostrar]').forEach(b => b.addEventListener('click', () => {
  const input = document.getElementById(b.dataset.mostrar);
  if (!input) return;
  const mostrar = input.type === 'password';
  input.type = mostrar ? 'text' : 'password';
  b.innerHTML = mostrar ? ic('olhoOff') + ' Ocultar' : ic('olho') + ' Mostrar';
}));

/* ----- WhatsApp (Evolution API) ----- */
async function salvarCfgWhats() {
  const payload = {
    whatsapp_ativo: $('#cfgWhatsAtivo').checked,
    evolution_url: $('#cfgWhatsUrl').value.trim(),
    evolution_instancia: $('#cfgWhatsInstancia').value.trim(),
  };
  const chave = $('#cfgWhatsApikey').value.trim();
  if (chave) payload.evolution_apikey = chave; // em branco = mantém a chave salva
  const c = await api('/api/painel/configuracoes', { method: 'PUT', body: payload });
  preencherConfiguracoes(c);
  
  return c;
}
$('#formCfgWhats').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await salvarCfgWhats(); toast('WhatsApp salvo.'); }
  catch (err) { toast(err.message, true); }
});
$('#btnCfgWhatsTestar').addEventListener('click', async () => {
  const res = $('#cfgWhatsResult');
  res.className = 'cfg-result';
  res.textContent = 'Salvando e testando a conexão...';
  try {
    await salvarCfgWhats();
    const data = await api('/api/painel/configuracoes/testar-whatsapp', { method: 'POST', body: {} });
    cfgResultado(res, !!data.ok, data.mensagem);
    if (data.ok) { toast('Conexão com o WhatsApp confirmada.');  }
  } catch (err) { cfgResultado(res, false, err.message); }
});
/* Teste REAL do WhatsApp (v1.9): manda uma mensagem de verdade pro número
   digitado — diferente do teste de conexão, que só confere a instância. */
$('#btnCfgWhatsTestarReal').addEventListener('click', async () => {
  const res = $('#cfgWhatsResultReal');
  const numero = $('#cfgWhatsNumeroTeste').value.trim();
  if (!numero) { cfgResultado(res, false, 'Informe o número de WhatsApp (com DDD) que deve receber a mensagem de teste.'); return; }
  res.className = 'cfg-result';
  res.textContent = 'Salvando e enviando a mensagem de teste...';
  try {
    await salvarCfgWhats();
    const data = await api('/api/painel/configuracoes/testar-whatsapp', { method: 'POST', body: { numero } });
    cfgResultado(res, !!data.ok, data.mensagem);
    if (data.ok) toast('Mensagem de teste enviada — confira o WhatsApp.');
  } catch (err) { cfgResultado(res, false, err.message); }
});

/* ----- Entregador 99 (v1.9.2 — config_entregadores) ----- */
function preencherCfg99(c) {
  if (!c) return;
  const pill = $('#cfg99Pill');
  pill.textContent = c.configurado ? 'Configurado' : (c.ativo ? 'Faltam credenciais' : 'Desligado');
  pill.className = 'cfg-pill ' + (c.configurado ? 'on' : 'sim');
  $('#cfg99Ativo').checked = !!c.ativo;
  $('#cfg99ApiBase').value = c.api_base || '';
  $('#cfg99ClientId').value = c.client_id || '';
  const sec = $('#cfg99ClientSecret');
  sec.value = '';
  sec.type = 'password';
  sec.placeholder = c.client_secret_configurado ? `Salvo (${c.client_secret_mascarado || '••••'}) — deixe em branco para manter` : 'Cole o Client Secret da 99 aqui';
  $('#cfg99LimparSecret').checked = false;
  $('#cfg99MerchantId').value = c.merchant_id || '';
  $('#cfg99MerchantName').value = c.merchant_name || '';
  $('#cfg99MerchantDoc').value = c.merchant_document || '';
  const pk = c.pickup || {};
  $('#cfg99PickRua').value = pk.logradouro || '';
  $('#cfg99PickNum').value = pk.numero || '';
  $('#cfg99PickComp').value = pk.complemento || '';
  $('#cfg99PickBairro').value = pk.bairro || '';
  $('#cfg99PickCidade').value = pk.cidade || '';
  $('#cfg99PickUf').value = pk.uf || '';
  $('#cfg99PickCep').value = pk.cep || '';
  $('#cfg99PickRef').value = pk.referencia || '';
  $('#cfg99PickFone').value = c.pickup_phone || '';
}
async function carregarCfg99() {
  try { preencherCfg99(await api('/api/painel/entregadores/config')); } catch { /* silencioso */ }
}
$('#formCfg99').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    ativo: $('#cfg99Ativo').checked,
    api_base: $('#cfg99ApiBase').value.trim(),
    client_id: $('#cfg99ClientId').value.trim(),
    merchant_id: $('#cfg99MerchantId').value.trim(),
    merchant_name: $('#cfg99MerchantName').value.trim(),
    merchant_document: $('#cfg99MerchantDoc').value.trim(),
    pickup_phone: $('#cfg99PickFone').value.trim(),
    pickup: {
      logradouro: $('#cfg99PickRua').value, numero: $('#cfg99PickNum').value,
      complemento: $('#cfg99PickComp').value, bairro: $('#cfg99PickBairro').value,
      cidade: $('#cfg99PickCidade').value, uf: $('#cfg99PickUf').value,
      cep: $('#cfg99PickCep').value, referencia: $('#cfg99PickRef').value,
    },
  };
  const segredo = $('#cfg99ClientSecret').value.trim();
  if (segredo) payload.client_secret = segredo; // em branco = mantém o salvo
  if ($('#cfg99LimparSecret').checked) payload.limpar_client_secret = true;
  try {
    const c = await api('/api/painel/entregadores/config', { method: 'PUT', body: payload });
    preencherCfg99(c);
    toast(c.configurado ? 'Entregador 99 salvo e ativo.' : 'Entregador 99 salvo — confira o ativo e as credenciais pra liberar a chamada automática.');
  } catch (err) { toast(err.message, true); }
});

/* ----- iFood (v1.11.3 — config_ifood) ----- */
function preencherCfgIfood(c) {
  if (!c) return;
  const pill = $('#cfgIfoodPill');
  pill.textContent = c.configurado ? (c.ativo ? 'Configurado' : 'Configurado (desligado)') : (c.ativo ? 'Faltam credenciais' : 'Desligado');
  pill.className = 'cfg-pill ' + (c.configurado && c.ativo ? 'on' : 'sim');
  $('#cfgIfoodAtivo').checked = !!c.ativo;
  $('#cfgIfoodClientId').value = c.client_id || '';
  const sec = $('#cfgIfoodClientSecret');
  sec.value = '';
  sec.type = 'password';
  sec.placeholder = c.client_secret_configurado ? `Salvo (${c.client_secret_mascarado || '••••'}) — deixe em branco para manter` : 'Cole o Client Secret aqui';
  $('#cfgIfoodLimparSecret').checked = false;
  $('#cfgIfoodMerchantId').value = c.merchant_id || '';
  const st = $('#cfgIfoodStats');
  if (st) st.textContent = c.total_importados
    ? `Já entraram ${c.total_importados} pedido(s) do iFood por aqui.` + (c.ultima_poll ? ` Última verificação: ${String(c.ultima_poll).slice(0, 16).replace('T', ' ')}.` : '')
    : 'Nenhum pedido do iFood entrou ainda. Com a integração ativa, o sistema verifica sozinho a cada 30 segundos.';
}
async function carregarCfgIfood() {
  try { preencherCfgIfood(await api('/api/painel/ifood/config')); } catch { /* silencioso */ }
}
$('#btnIfoodVerificar').addEventListener('click', async () => {
  try {
    const r = await api('/api/painel/ifood/verificar', { method: 'POST', body: {} });
    if (!r.ok) { toast(r.motivo || 'A integração está desligada.', true); return; }
    toast(r.importados ? `${r.importados} pedido(s) novo(s) do iFood entraram!` : 'Verificação feita: nenhum pedido novo no iFood.');
    carregarCfgIfood();
    carregarPedidos();
  } catch (err) { toast(err.message, true); }
});
$('#formCfgIfood').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/painel/ifood/config', {
      method: 'PUT',
      body: {
        ativo: $('#cfgIfoodAtivo').checked,
        client_id: $('#cfgIfoodClientId').value.trim(),
        client_secret: $('#cfgIfoodClientSecret').value,
        merchant_id: $('#cfgIfoodMerchantId').value.trim(),
        limpar_secret: $('#cfgIfoodLimparSecret').checked,
      },
    });
    preencherCfgIfood(r);
    toast('Configuração do iFood salva.');
  } catch (err) { toast(err.message, true); }
});
$('#btnCfg99Testar').addEventListener('click', async () => {
  const res = $('#cfg99Result');
  res.classList.remove('hidden');
  res.textContent = 'Testando a credencial na 99...';
  try {
    const r = await api('/api/painel/entregadores/testar', { method: 'POST', body: {} });
    cfgResultado(res, !!r.ok, r.mensagem || (r.ok ? 'Credencial aceita pela 99.' : 'Não foi possível validar a credencial.'));
  } catch (err) { cfgResultado(res, false, err.message); }
});

/* ----- Telegram do dono ----- */
async function salvarCfgTelegram() {
  const payload = {
    telegram_ativo: $('#cfgTgAtivo').checked,
    telegram_chat_id: $('#cfgTgChatId').value.trim(),
  };
  const token = $('#cfgTgToken').value.trim();
  if (token) payload.telegram_bot_token = token; // em branco = mantém o token salvo
  const c = await api('/api/painel/configuracoes', { method: 'PUT', body: payload });
  preencherConfiguracoes(c);
  
  return c;
}
$('#formCfgTelegram').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await salvarCfgTelegram(); toast('Telegram salvo.'); }
  catch (err) { toast(err.message, true); }
});
$('#btnCfgTgDetectar').addEventListener('click', async () => {
  const info = $('#cfgTgDetect');
  const btn = $('#btnCfgTgDetectar');
  btn.disabled = true;
  info.className = 'cfg-result';
  info.textContent = 'Procurando sua conversa com o bot...';
  try {
    const data = await api('/api/painel/configuracoes/telegram/detectar-chat', { method: 'POST', body: {} });
    if (data && data.ok === false) {
      cfgResultado(info, false, data.mensagem || 'Nenhuma conversa encontrada. Abra o bot, mande um "oi", aguarde uns segundos e tente de novo.');
      btn.disabled = false;
      return;
    }
    let chatId = data ? (data.chat_id ?? data.id) : null;
    let nome = data ? data.nome : '';
    let username = data ? data.username : '';
    let aviso = '';
    if ((chatId === null || chatId === undefined || chatId === '') && data && Array.isArray(data.chats) && data.chats.length) {
      const primeiro = data.chats[0] || {};
      chatId = primeiro.chat_id ?? primeiro.id;
      nome = primeiro.nome || nome;
      username = primeiro.username || username;
      if (data.chats.length > 1) aviso = ` Encontramos ${data.chats.length} conversas e usamos a primeira — confira se é a sua.`;
    }
    if (chatId !== null && chatId !== undefined && chatId !== '') {
      $('#cfgTgChatId').value = String(chatId);
      const quem = String(nome || 'conversa').trim();
      const userTxt = username ? ' (@' + String(username).replace(/^@/, '') + ')' : '';
      cfgResultado(info, true, `Detectado: ${quem}${userTxt} — Chat ID ${chatId}.${aviso} Agora clique em "Salvar Telegram" para gravar.`);
    } else {
      cfgResultado(info, false, (data && data.mensagem) || 'Nenhuma conversa encontrada. Abra o bot, mande um "oi", aguarde uns segundos e tente de novo.');
    }
  } catch (err) { cfgResultado(info, false, err.message); }
  btn.disabled = false;
});
$('#btnCfgTgVinculo').addEventListener('click', async () => {
  const btn = $('#btnCfgTgVinculo');
  const box = $('#cfgTgVinculo');
  btn.disabled = true;
  try {
    const data = await api('/api/painel/configuracoes/telegram/vinculo', { method: 'POST', body: {} });
    box.classList.remove('hidden');
    if (data && data.ok && data.codigo) {
      cfgResultado(box, true, 'Seu código é ' + data.codigo + ' — abra o bot no SEU Telegram e envie: /vincular ' + data.codigo + ' (vale 10 minutos, uma única vez). Quando o bot responder confirmando, esta conversa vira a do dono.');
    } else {
      cfgResultado(box, false, (data && data.erro) || 'Não consegui gerar o código.');
    }
  } catch (err) { box.classList.remove('hidden'); cfgResultado(box, false, err.message); }
  btn.disabled = false;
});
$('#btnCfgTgWebhook').addEventListener('click', async () => {
  const btn = $('#btnCfgTgWebhook');
  const box = $('#cfgTgWebhook');
  btn.disabled = true;
  try {
    const data = await api('/api/painel/configuracoes/telegram/registrar-webhook', { method: 'POST', body: {} });
    box.classList.remove('hidden');
    cfgResultado(box, !!(data && data.ok), (data && (data.mensagem || data.erro)) || 'Sem resposta do servidor.');
    if (data && data.ok) { const wst = $('#cfgTgWebhookStatus'); if (wst) wst.textContent = 'Status: webhook REGISTRADO e protegido.'; }
  } catch (err) { box.classList.remove('hidden'); cfgResultado(box, false, err.message); }
  btn.disabled = false;
});
$('#btnBackup').addEventListener('click', async () => {
  const btn = $('#btnBackup');
  btn.disabled = true;
  try {
    const resp = await fetch('/api/painel/backup', { headers: { Authorization: 'Bearer ' + state.token } });
    if (!resp.ok) throw new Error('Não consegui gerar o backup agora.');
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'backup-acai-do-guri.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Backup baixado. Guarde o arquivo em lugar seguro.');
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
});
$('#btnCfgTgTestar').addEventListener('click', async () => {
  const res = $('#cfgTgResult');
  res.className = 'cfg-result';
  res.textContent = 'Salvando e testando...';
  try {
    await salvarCfgTelegram();
    const data = await api('/api/painel/configuracoes/testar-telegram', { method: 'POST', body: {} });
    let mensagem = data.mensagem || '';
    if (data.bot_username) {
      const bot = '@' + String(data.bot_username).replace(/^@/, '');
      mensagem = (mensagem ? mensagem + ' ' : '') + `Bot: ${bot}.`;
    }
    cfgResultado(res, !!data.ok, mensagem);
    if (data.ok) { toast('Teste enviado pro seu Telegram.');  }
  } catch (err) { cfgResultado(res, false, err.message); }
});

/* ================= PONTO ELETRÔNICO (v1.8 — funcionário) ================= */
function iniciarPonto() {
  carregarPonto();
  if (state.pontoTimer) clearInterval(state.pontoTimer);
  state.pontoTimer = setInterval(carregarPonto, 30000);
}
async function carregarPonto() {
  // v1.9.6: quem não é funcionário não tem cartão de ponto — e ele precisa
  // SUMIR na troca de usuário sem recarregar a página (antes o retorno
  // seco deixava o cartão do funcionário anterior desenhado na tela do
  // admin, parecendo que o admin tinha batido ponto).
  if (!state.user || state.user.perfil !== 'funcionario') { state.ponto = null; renderPonto(); return; }
  // v1.11.0: funcionário não bate mais ponto — quem manda é a trava
  // TRABALHANDO (carregarTrabalho). O cartão some e o histórico antigo
  // continua visível pro admin em Equipe.
  state.ponto = null;
  renderPonto();
}
/* ---------- Trava Trabalhando (v1.11.0) ---------- */
function horaDe(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T'));
  return isNaN(d) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function aplicarTrava(on, desde) {
  state.trabalhando = !!on;
  const card = $('#travaCard');
  if (!card) return;
  card.classList.remove('hidden');
  card.classList.toggle('on', !!on);
  $('#view-pedidos').classList.toggle('travado', !on);
  $('#travaTitulo').textContent = on ? 'Você está trabalhando' : 'Você ainda não está trabalhando';
  $('#travaSub').textContent = on
    ? 'Os pedidos estão liberados pra você' + (desde ? ' · desde ' + horaDe(desde) : '') + '.'
    : 'Toque em TRABALHANDO pra liberar os pedidos. O administrador é avisado quando você começa.';
  $('#btnTrabalhar').textContent = on ? 'ENCERRAR' : 'TRABALHANDO';
}
async function carregarTrabalho() {
  if (!state.user || state.user.perfil !== 'funcionario') return;
  try {
    const r = await api('/api/painel/trabalhando');
    aplicarTrava(r.trabalhando, r.desde);
  } catch { /* sem o visual, o servidor continua barrando */ }
}
$('#btnTrabalhar').addEventListener('click', async () => {
  try {
    const r = await api('/api/painel/trabalhando', { method: 'POST', body: { ativo: !state.trabalhando } });
    aplicarTrava(r.trabalhando, r.desde);
    toast(r.trabalhando ? 'Você começou a trabalhar — pedidos liberados!' : 'Turno encerrado.');
    if (r.trabalhando) carregarPedidos();
  } catch (e) { toast(e.message || 'Não consegui mudar seu estado.', true); }
});

function turnoTexto(j) {
  if (!j) return 'Sem jornada definida — o ponto funciona, mas sem alerta de fim de turno.';
  const dias = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const lista = String(j.dias_semana || '').split(',').filter(s => s !== '').map(n => dias[Number(n)]).filter(Boolean);
  return `Seu turno: ${j.hora_entrada}–${j.hora_saida}${lista.length ? ' · ' + lista.join(', ') : ''}`;
}
function renderPonto() {
  const card = $('#pontoCard');
  const p = state.ponto;
  if (!p || !state.user || state.user.perfil !== 'funcionario') { card.classList.add('hidden'); card.innerHTML = ''; return; }
  card.classList.remove('hidden');
  if (p.estado === 'sem_entrada') {
    card.innerHTML = `<div class="ponto-info">${ic('relogio')} <strong>Ponto de hoje</strong><br>Você ainda não bateu a entrada.<br><span style="opacity:.85">${esc(turnoTexto(p.jornada))}</span></div>
      <button class="btn btn-ok btn-ponto" id="btnPontoEntrada" type="button"><span class="dot dot-verde"></span> Bater ponto de entrada</button>`;
    $('#btnPontoEntrada').addEventListener('click', baterEntrada);
  } else if (p.estado === 'trabalhando') {
    card.innerHTML = `<div class="ponto-info"><span class="dot dot-verde"></span> <strong>Você entrou às ${esc(p.entrada.hora)}</strong><br><span style="opacity:.85">${esc(turnoTexto(p.jornada))}</span></div>
      <button class="btn btn-danger btn-ponto" id="btnPontoSaida" type="button"><span class="dot dot-vermelho"></span> Bater ponto de saída</button>`;
    $('#btnPontoSaida').addEventListener('click', baterSaida);
  } else {
    let dur = '';
    if (p.entrada && p.saida) {
      const ini = dataServidor(p.entrada.registrado_em), fim = dataServidor(p.saida.registrado_em);
      if (ini && fim) {
        const min = Math.max(0, Math.round((fim - ini) / 60000));
        dur = ` · ${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')} trabalhadas`;
      }
    }
    card.innerHTML = `<div class="ponto-info">${ic('checkCirculo')} <strong>Expediente de hoje encerrado</strong><br><span style="opacity:.85">Entrada ${esc(p.entrada ? p.entrada.hora : '—')} · Saída ${esc(p.saida ? p.saida.hora : '—')}${dur}</span></div>`;
  }
}
async function baterEntrada() {
  try {
    const r = await api('/api/painel/ponto/entrada', { method: 'POST', body: {} });
    toast(`Ponto de entrada registrado às ${r.hora}. Bom trabalho!`);
    carregarPonto();
  } catch (err) { toast(err.message, true); }
}
async function baterSaida() {
  if (!confirm('Bater o ponto de saída? Sua sessão será encerrada.')) return;
  try {
    const r = await api('/api/painel/ponto/saida', { method: 'POST', body: {} });
    const hora = r.saida && r.saida.hora;
    pararAlertaSaida();
    sair(false); // o servidor já invalidou o token nesta chamada
    toast(`Ponto de saída registrado${hora ? ' às ' + hora : ''}. Até logo!`);
  } catch (err) { toast(err.message, true); }
}
/* Alerta de fim de expediente: faltando ≤5 min pra hora_saida com a entrada
   aberta, banner fixo + som alto em loop até bater a saída ou clicar Entendi. */
function verificarAlertaSaida() {
  const p = state.ponto;
  const deve = !!p && p.estado === 'trabalhando'
    && p.faltam_min_para_saida !== null && p.faltam_min_para_saida !== undefined
    && p.faltam_min_para_saida <= 5;
  if (!deve) { state.alertaSilenciado = false; pararAlertaSaida(); return; }
  if (state.alertaSilenciado) return;
  $('#alertaSaida').classList.remove('hidden');
  const audio = $('#alertaAudio');
  if (audio && audio.paused) { audio.volume = 1; audio.play().catch(() => { /* libera após interação */ }); }
}
function pararAlertaSaida() {
  const banner = $('#alertaSaida');
  if (banner) banner.classList.add('hidden');
  const audio = $('#alertaAudio');
  if (audio && !audio.paused) { try { audio.pause(); audio.currentTime = 0; } catch { /* ok */ } }
}
$('#btnAlertaEntendi').addEventListener('click', () => { state.alertaSilenciado = true; pararAlertaSaida(); });

/* ================= EQUIPE (v1.8 — só admin) ================= */
const DIA_CURTO = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
function diasTexto(diasSemana) {
  const arr = String(diasSemana || '').split(',').filter(s => s !== '').map(Number);
  return arr.length ? arr.map(n => DIA_CURTO[n]).filter(Boolean).join(' ') : 'todos os dias';
}
// ---------------- Recuperação de senha (v1.9.22, admin) ----------------
async function carregarRecuperacao() {
  const el = $('#recuperacaoList');
  if (!el) return;
  try {
    const r = await api('/api/painel/recuperacao');
    const lista = r.pedidos || [];
    const pendentes = lista.filter(p => p.status === 'pendente');
    const resolvidos = lista.filter(p => p.status !== 'pendente').slice(0, 5);
    el.innerHTML = `
      ${pendentes.length ? `<table class="simple-table"><thead><tr><th>Quem pediu</th><th>Quando</th><th></th></tr></thead>
        <tbody>${pendentes.map(p => `<tr>
          <td><strong>${esc(p.nome)}</strong><br><span class="dica">usuário ${esc(p.login)}</span></td>
          <td>${fidDataFmt(p.criado_em)}</td>
          <td class="acoes-cell">
            <button type="button" class="btn btn-primary btn-sm" data-rec-gerar="${p.id}">Gerar senha temporária</button>
            <button type="button" class="btn btn-ghost btn-sm" data-rec-cancelar="${p.id}">Ignorar</button>
          </td></tr>`).join('')}</tbody></table>`
        : '<p class="dica">Nenhum pedido esperando. Quando alguém pedir, aparece aqui (e você é avisado no Telegram e no push).</p>'}
      ${resolvidos.length ? `<p class="dica" style="margin-top:.6rem">${resolvidos.map(p =>
        `${esc(p.nome)} — ${p.status === 'atendida' ? `atendido por ${esc(p.atendido_por || 'ADM')} em ${fidDataFmt(p.atendido_em)}` : p.status}`).join('<br>')}</p>` : ''}`;
  } catch { el.innerHTML = '<p class="dica">Não consegui carregar os pedidos agora.</p>'; }
}
document.addEventListener('click', async (e) => {
  const gerar = e.target.closest('[data-rec-gerar]');
  const cancelar = e.target.closest('[data-rec-cancelar]');
  if (gerar) {
    const r = await api(`/api/painel/recuperacao/${gerar.dataset.recGerar}/gerar`, { method: 'POST', body: {} }).catch((err) => ({ erro: err.message }));
    if (!r || r.erro) { toast((r && r.erro) || 'Não consegui gerar.', true); return; }
    const body = openModal('Senha temporária de ' + r.nome, `
      <p class="dica">Passe esta senha para <strong>${esc(r.nome)}</strong> (usuário <strong>${esc(r.login)}</strong>). É com ela que a pessoa entra — e o painel vai obrigar a criar a senha nova na hora. Ela não aparece de novo aqui.</p>
      <div class="qr-texto" style="font-size:1.3rem;text-align:center;letter-spacing:.06em" id="recTempTxt">${esc(r.temporaria)}</div>
      <div class="form-actions">
        <button type="button" class="btn btn-primary" id="recTempCopiar">Copiar senha</button>
        <button type="button" class="btn btn-ghost" id="recTempOk">Já passei, fechar</button>
      </div>`);
    $('#recTempCopiar', body).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(r.temporaria); toast('Senha copiada!'); }
      catch { toast('Selecione a senha e copie manualmente.'); }
    });
    $('#recTempOk', body).addEventListener('click', closeModal);
    carregarRecuperacao();
  }
  if (cancelar) {
    await api(`/api/painel/recuperacao/${cancelar.dataset.recCancelar}/cancelar`, { method: 'POST', body: {} }).catch(() => {});
    carregarRecuperacao();
  }
});

async function carregarEquipe() {
  try {
    state.equipe = await api('/api/painel/equipe');
    renderEquipe();
  } catch (err) { toast(err.message, true); }
}
function renderEquipe() {
  const box = $('#equipeList');
  if (!state.equipe.length) { box.innerHTML = '<p class="dica">Nenhum funcionário cadastrado ainda.</p>'; return; }
  box.innerHTML = `<table class="simple-table">
    <thead><tr><th>Nome</th><th>Login</th><th>Turno</th><th>Dias</th><th>Status</th><th></th></tr></thead>
    <tbody>${state.equipe.map(f => `<tr>
      <td><strong>${esc(f.nome)}</strong></td>
      <td>${esc(f.login)}</td>
      <td>${f.hora_entrada ? `${esc(f.hora_entrada)}–${esc(f.hora_saida)}` : '<span class="dica">sem jornada</span>'}</td>
      <td>${f.hora_entrada ? esc(diasTexto(f.dias_semana)) : '—'}</td>
      <td>${f.ativo ? '<span class="dot dot-verde"></span> Ativo' : '<span class="dot dot-vermelho"></span> Inativo'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm" data-eq-edit="${f.id}">Editar</button>
        <button class="btn btn-ghost btn-sm" data-eq-senha="${f.id}">Senha</button>
        <button class="btn btn-ghost btn-sm" data-eq-ativo="${f.id}">${f.ativo ? 'Inativar' : 'Ativar'}</button>
        <button class="btn btn-ghost btn-sm" data-eq-del="${f.id}">Excluir</button>
      </td></tr>`).join('')}</tbody></table>`;
  $$('#equipeList [data-eq-edit]').forEach(b => b.addEventListener('click', () => modalFuncionario(state.equipe.find(f => String(f.id) === b.dataset.eqEdit))));
  $$('#equipeList [data-eq-senha]').forEach(b => b.addEventListener('click', () => modalSenhaFuncionario(state.equipe.find(f => String(f.id) === b.dataset.eqSenha))));
  $$('#equipeList [data-eq-ativo]').forEach(b => b.addEventListener('click', async () => {
    const f = state.equipe.find(x => String(x.id) === b.dataset.eqAtivo);
    try {
      await api('/api/painel/equipe/' + f.id, { method: 'PUT', body: { ativo: !f.ativo } });
      toast(f.ativo ? `"${f.nome}" inativado — não consegue mais entrar.` : `"${f.nome}" ativado.`);
      carregarEquipe();
    } catch (err) { toast(err.message, true); }
  }));
  $$('#equipeList [data-eq-del]').forEach(b => b.addEventListener('click', async () => {
    const f = state.equipe.find(x => String(x.id) === b.dataset.eqDel);
    if (!confirm(`Excluir o funcionário "${f.nome}"? Quem já bateu ponto não pode ser excluído (só inativado).`)) return;
    try {
      await api('/api/painel/equipe/' + f.id, { method: 'DELETE' });
      toast('Funcionário excluído.');
      carregarEquipe(); carregarPontoRelatorio();
    } catch (err) { toast(err.message, true); }
  }));
}
function modalFuncionario(f) {
  const edit = !!f;
  f = f || { nome: '', login: '', ativo: true, hora_entrada: '14:00', hora_saida: '22:00', dias_semana: '1,2,3,4,5,6', janela_antes_min: 30, janela_depois_min: 30 };
  const diasSel = new Set(String(f.dias_semana || '').split(',').filter(s => s !== ''));
  const diaChk = (n, rot) => `<label class="chk"><input type="checkbox" class="eq-dia" value="${n}" ${diasSel.has(String(n)) ? 'checked' : ''}> ${rot}</label>`;
  const body = openModal(edit ? 'Editar funcionário' : 'Novo funcionário', `
    <form id="formFuncionario">
      <div class="grid-2">
        <label>Nome <input type="text" id="eqNome" value="${esc(f.nome)}" required></label>
        <label>Login <input type="text" id="eqLogin" value="${esc(f.login)}" autocomplete="off" required></label>
      </div>
      ${edit ? '' : '<label>Senha inicial <input type="text" id="eqSenha" minlength="8" autocomplete="off" required placeholder="Mínimo 8 caracteres"></label>'}
      <div class="grid-2">
        <label>Hora de entrada <input type="time" id="eqEntrada" value="${esc(f.hora_entrada || '')}"></label>
        <label>Hora de saída <input type="time" id="eqSaida" value="${esc(f.hora_saida || '')}"></label>
        <label>Pode entrar até (min antes) <input type="number" id="eqAntes" min="0" max="240" value="${f.janela_antes_min ?? 30}"></label>
        <label>Pode ficar até (min depois) <input type="number" id="eqDepois" min="0" max="240" value="${f.janela_depois_min ?? 30}"></label>
      </div>
      <span style="font-size:.85rem;font-weight:600">Dias de trabalho</span>
      <div class="dias-checks">${diaChk(1, 'Seg')}${diaChk(2, 'Ter')}${diaChk(3, 'Qua')}${diaChk(4, 'Qui')}${diaChk(5, 'Sex')}${diaChk(6, 'Sáb')}${diaChk(0, 'Dom')}</div>
      <label class="chk"><input type="checkbox" id="eqAtivo" ${f.ativo ? 'checked' : ''}> Ativo (pode entrar no sistema)</label>
      <p class="dica">Fora da janela (dias e horários, com as tolerâncias), o login do funcionário é recusado. Deixe entrada e saída vazios para não limitar o horário. Turno que cruza a meia-noite não é suportado.</p>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Salvar funcionário</button></div>
    </form>`);
  $('#formFuncionario', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const tol = (id) => { const v = $(id, body).value; return v === '' ? 30 : Number(v); };
    const payload = {
      nome: $('#eqNome', body).value.trim(),
      login: $('#eqLogin', body).value.trim(),
      ativo: $('#eqAtivo', body).checked,
      hora_entrada: $('#eqEntrada', body).value || null,
      hora_saida: $('#eqSaida', body).value || null,
      janela_antes_min: tol('#eqAntes'),
      janela_depois_min: tol('#eqDepois'),
      dias_semana: $$('.eq-dia', body).filter(x => x.checked).map(x => x.value).join(','),
    };
    if (!edit) payload.senha = $('#eqSenha', body).value;
    try {
      if (edit) await api('/api/painel/equipe/' + f.id, { method: 'PUT', body: payload });
      else await api('/api/painel/equipe', { method: 'POST', body: payload });
      closeModal(); toast('Funcionário salvo.'); carregarEquipe(); carregarPontoRelatorio();
    } catch (err) { toast(err.message, true); }
  });
}
$('#btnNovoFuncionario').addEventListener('click', () => modalFuncionario(null));
function modalSenhaFuncionario(f) {
  if (!f) return;
  const body = openModal('Redefinir senha — ' + f.nome, `
    <form id="formSenhaFunc">
      <label>Nova senha <input type="text" id="eqNovaSenha" minlength="8" autocomplete="off" required placeholder="Mínimo 8 caracteres"></label>
      <p class="dica">Ao redefinir, as sessões abertas deste funcionário são encerradas.</p>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Redefinir senha</button></div>
    </form>`);
  $('#formSenhaFunc', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/painel/equipe/' + f.id + '/senha', { method: 'POST', body: { nova_senha: $('#eqNovaSenha', body).value } });
      closeModal(); toast('Senha redefinida.');
    } catch (err) { toast(err.message, true); }
  });
}

/* ----- Ponto do mês (admin) ----- */
async function carregarPontoRelatorio() {
  if (!state.pontoMes) state.pontoMes = mesAtualLocal();
  const inp = $('#pontoMes');
  if (inp && inp.value !== state.pontoMes) inp.value = state.pontoMes;
  try {
    const r = await api('/api/painel/equipe/ponto?mes=' + encodeURIComponent(state.pontoMes));
    renderPontoRelatorio(r);
  } catch (err) { toast(err.message, true); }
}
function renderPontoRelatorio(r) {
  const box = $('#pontoRelatorio');
  const funcs = (r && r.funcionarios) || [];
  if (!funcs.length) { box.innerHTML = '<p class="dica">Nenhum funcionário cadastrado.</p>'; return; }
  box.innerHTML = funcs.map(f => `
    <div class="ponto-func-head"><h4>${ic('pessoa')} ${esc(f.nome)} <span class="dica">(${esc(f.login)})</span></h4><span class="total">Total no mês: ${esc(f.total_formatado)}</span></div>
    ${f.dias && f.dias.length ? `<table class="simple-table">
      <thead><tr><th>Data</th><th>Entrada</th><th>Saída</th><th>Horas</th><th></th></tr></thead>
      <tbody>${f.dias.map(d => `<tr class="${d.aberto ? 'ponto-aberto' : ''}">
        <td>${fmtDataBR(d.data)}</td>
        <td>${esc(d.entrada || '—')}</td>
        <td>${esc(d.saida || '—')}</td>
        <td><strong>${esc(d.horas)}</strong></td>
        <td>${d.aberto ? `<span class="fin-tipo despesa">Em aberto</span> <button class="btn btn-ghost btn-sm" data-fechar-dia="${f.usuario_id}|${d.data}">Fechar dia</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>`
    : '<p class="dica">Sem registros de ponto neste mês.</p>'}`).join('');
  $$('#pontoRelatorio [data-fechar-dia]').forEach(b => b.addEventListener('click', () => {
    const [uid, data] = b.dataset.fecharDia.split('|');
    const f = funcs.find(x => String(x.usuario_id) === uid);
    modalAjustePonto({ usuario_id: Number(uid), tipo: 'saida', data, hora: (f && f.hora_saida) || '' });
  }));
}
$('#pontoMes').addEventListener('change', (e) => {
  state.pontoMes = e.target.value || mesAtualLocal();
  carregarPontoRelatorio();
});
$('#btnNovoAjustePonto').addEventListener('click', () => modalAjustePonto(null));
function modalAjustePonto(preset) {
  preset = preset || {};
  if (!state.equipe.length) { toast('Cadastre um funcionário primeiro.', true); return; }
  const body = openModal('Lançar ajuste de ponto', `
    <form id="formAjustePonto">
      <label>Funcionário
        <select id="ajFuncionario">${state.equipe.map(f => `<option value="${f.id}" ${Number(preset.usuario_id) === Number(f.id) ? 'selected' : ''}>${esc(f.nome)} (${esc(f.login)})</option>`).join('')}</select>
      </label>
      <div class="grid-2">
        <label>Tipo
          <select id="ajTipo">
            <option value="entrada" ${preset.tipo === 'entrada' ? 'selected' : ''}>Entrada</option>
            <option value="saida" ${preset.tipo === 'saida' ? 'selected' : ''}>Saída</option>
          </select>
        </label>
        <label>Data <input type="date" id="ajData" value="${esc(preset.data || hojeLocal())}" required></label>
        <label>Hora <input type="time" id="ajHora" value="${esc(preset.hora || '')}" required></label>
      </div>
      <label>Observação (opcional) <input type="text" id="ajObs" placeholder="Ex.: esqueceu de bater — fechado pelo admin"></label>
      <p class="dica">O ajuste entra com origem "admin" e vale pro relatório do mês na hora.</p>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Lançar ajuste</button></div>
    </form>`);
  $('#formAjustePonto', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/painel/equipe/ponto/ajuste', {
        method: 'POST',
        body: {
          usuario_id: Number($('#ajFuncionario', body).value),
          tipo: $('#ajTipo', body).value,
          data: $('#ajData', body).value,
          hora: $('#ajHora', body).value,
          observacao: $('#ajObs', body).value.trim() || undefined,
        },
      });
      closeModal(); toast('Ajuste lançado.'); carregarPontoRelatorio();
    } catch (err) { toast(err.message, true); }
  });
}

/* ================= INICIALIZAÇÃO ================= */
function iniciarApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  estadoBotaoPush();
  if (state.user && state.user.precisa_trocar_senha) abrirTrocaSenhaForcada();
  const ehAdmin = !state.user || state.user.perfil === 'admin';
  if (state.user) {
    $('#userNome').textContent = state.user.nome || 'Admin';
    $('#userPerfil').textContent = '· ' + (ehAdmin ? 'Administrador' : 'Funcionário');
  }
  // Funcionário não vê os menus de gestão (o servidor barra com 403 também).
  document.body.classList.toggle('perfil-func', !ehAdmin);
  initAcordeoesConfig();
  if (!ehAdmin) carregarTrabalho();
  carregarLoja().then(async () => {
    // O selo do menu reflete os passos que faltam em qualquer instalação.
    if (!ehAdmin) return;
    try {
      const feitos = await carregarPassos();
      // Instalação nova (loja ainda "Minha Loja"): abre o assistente,
      // salvo se o dono já dispensou a abertura automática.
      if (state.loja && state.loja.nome === 'Minha Loja' && feitos < 10) {
        const p = await api('/api/painel/primeiros-passos');
        if (!p.ocultar) irPara('primeiros-passos');
      }
    } catch { /* silencioso */ }
  });
  
  irPara('pedidos');
  conectarStream();
  if (!ehAdmin) iniciarPonto();
}
if (state.token) {
  // v1.13.10: valida a sessao salva ANTES de abrir o app. Token velho ou de
  // outro banco e limpo EM SILENCIO — nada do toast "Sessao expirada"
  // assustando na abertura (acontecia a cada troca de servidor/banco).
  (async () => {
    try {
      const r = await fetch('/api/painel/loja', { headers: { Authorization: 'Bearer ' + state.token } });
      if (!r.ok) throw new Error('sessao invalida');
      iniciarApp();
    } catch { sair(false); }
  })();
}

/* Menu lateral retrátil (v1.9.26): o hambúrguer fixa/solta o menu aberto. */
(function () {
  const btn = document.getElementById('btnMenuLateral');
  if (!btn) return;
  if (localStorage.getItem('guri-menu-fixado') === '1') document.body.classList.add('menu-fixado');
  btn.addEventListener('click', () => {
    const fixo = document.body.classList.toggle('menu-fixado');
    localStorage.setItem('guri-menu-fixado', fixo ? '1' : '0');
    btn.title = fixo ? 'Soltar o menu (recolhe sozinho)' : 'Fixar o menu aberto';
  });
  if (document.body.classList.contains('menu-fixado')) btn.title = 'Soltar o menu (recolhe sozinho)';
})();

// Marca da loja na tela de login + favicon, antes mesmo de entrar (v1.13.5)
(async () => {
  try {
    const r = await fetch('/api/public/loja');
    if (!r.ok) return;
    const l = await r.json();
    if (l.logo_url) { const img = document.querySelector('.login-logo'); if (img) { img.src = l.logo_url; img.style.display = ''; } }
    faviconDaLoja(l.logo_url, l.cor_primaria);
  } catch { /* silencioso */ }
})();
