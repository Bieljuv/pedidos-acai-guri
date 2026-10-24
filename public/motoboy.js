'use strict';
/* Painel do motoboy (v1.16.20) — só os pedidos direcionados a ele:
   aceitar → confirmar recebimento (vira SAIU_ENTREGA pro cliente) →
   código do cliente → baixa. Sons de recebimento e de saída, e
   configurações limitadas a senha + sons. */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBRL = (c) => 'R$ ' + (Number(c || 0) / 100).toFixed(2).replace('.', ',');
const STATUS_ROTULO = { NOVO: 'Novo', EM_PREPARO: 'Em preparo', PRONTO: 'Pronto para retirar', SAIU_ENTREGA: 'A caminho' };

let token = null, nome = null, pollTimer = null, ultimoMapa = {}, primeiraCarga = true;
try { token = localStorage.getItem('motoboy_token'); nome = localStorage.getItem('motoboy_nome'); } catch { /* sem storage */ }

async function api(path, opts) {
  const r = await fetch(path, {
    method: (opts && opts.method) || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.erro || 'Erro na requisição.'); e.status = r.status; throw e; }
  return d;
}

/* ---------- Push (v1.16.24) ---------- */
// Mesma infra do painel (VAPID): o motoboy ativa no aparelho dele e recebe
// "novo pedido" e "pedido pronto" mesmo com a página fechada.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/motoboy-sw.js').catch(() => { /* sem SW, sem push — a página segue normal */ });
}
function vapidParaBytes(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
const pushSuportado = 'PushManager' in window && 'serviceWorker' in navigator && 'Notification' in window;
async function atualizarPushStatus() {
  const st = $('#pushStatus'), btn = $('#btnPush'), tst = $('#btnPushTeste');
  if (!st || !btn || !tst) return;
  if (!pushSuportado) {
    st.textContent = 'Este aparelho/navegador não suporta notificações.';
    btn.hidden = true; tst.hidden = true; return;
  }
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    const sub = await reg.pushManager.getSubscription();
    if (Notification.permission === 'granted' && sub) {
      st.textContent = 'Notificações ativas neste aparelho — você recebe aviso de pedido novo e de pedido pronto, mesmo com a página fechada.';
      btn.hidden = true; tst.hidden = false;
    } else if (Notification.permission === 'denied') {
      st.textContent = 'Notificações bloqueadas neste aparelho — libere nas configurações do navegador para ativar.';
      btn.hidden = true; tst.hidden = true;
    } else {
      st.textContent = 'Ative para receber aviso de pedido novo e de pedido pronto, mesmo com a página fechada.';
      btn.hidden = false; tst.hidden = true;
    }
  } catch {
    st.textContent = 'Não foi possível verificar as notificações neste aparelho.';
  }
}
$('#btnPush').addEventListener('click', async () => {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { atualizarPushStatus(); return; }
    const reg = await navigator.serviceWorker.ready;
    const r = await api('/api/motoboy/push/chave');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidParaBytes(r.chave) });
    await api('/api/motoboy/push/inscrever', { method: 'POST', body: { subscription: sub.toJSON() } });
    atualizarPushStatus();
  } catch (err) { alert('Não foi possível ativar as notificações: ' + err.message); }
});
$('#btnPushTeste').addEventListener('click', async () => {
  try { await api('/api/motoboy/push/testar', { method: 'POST', body: {} }); alert('Teste enviado — deve chegar em segundos.'); }
  catch (err) { alert(err.message); }
});

/* ---------- Sons ---------- */
const somRec = new Audio('/sons/alerta-sis.mp3');
const somSaiu = new Audio('/sons/moto.mp3');
let audioOk = false;
document.addEventListener('pointerdown', () => {
  if (audioOk) return;
  audioOk = true;
  [somRec, somSaiu].forEach(a => { try { a.play().then(() => a.pause()).catch(() => {}); } catch { /* sem áudio */ } });
}, { once: false });
const semSom = () => { try { return localStorage.getItem('motoboy_sem_som') === '1'; } catch { return false; } };
const somOn = (chave) => { try { return localStorage.getItem(chave) !== '0'; } catch { return true; } };
function tocar(audio, chave) {
  if (!audioOk || semSom() || !somOn(chave)) return;
  try { audio.currentTime = 0; audio.play().catch(() => {}); } catch { /* sem áudio */ }
}
const SVG_SOM_ON = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.4 5.6a9 9 0 0 1 0 12.8"/></svg>';
const SVG_SOM_OFF = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M22 9l-6 6"/><path d="M16 9l6 6"/></svg>';
function renderBtnSom() { $('#btnSom').innerHTML = semSom() ? SVG_SOM_OFF : SVG_SOM_ON; }
/* Som repetindo até aceitar (v1.16.24): enquanto houver pedido sem aceite,
   o som de recebimento repete a cada 15s — só com a página aberta e o som
   ligado. Ao aceitar (ou ao sair), para. */
let somRepeteTimer = null;
function atualizarSomRepetido(lista) {
  const pendente = (lista || []).some(p => !p.motoboy_aceito_em);
  if (pendente && !somRepeteTimer) {
    somRepeteTimer = setInterval(() => tocar(somRec, 'motoboy_som_recebimento'), 15000);
  } else if (!pendente && somRepeteTimer) {
    clearInterval(somRepeteTimer); somRepeteTimer = null;
  }
}
$('#btnSom').addEventListener('click', () => {
  try { localStorage.setItem('motoboy_sem_som', semSom() ? '0' : '1'); } catch { /* sem storage */ }
  renderBtnSom();
});

/* ---------- Telas ---------- */
function mostrar(tela) {
  $('#viewLogin').hidden = tela !== 'login';
  $('#viewPedidos').hidden = tela !== 'pedidos';
  $('#viewConfig').hidden = tela !== 'config';
  $('#viewFinanceiro').hidden = tela !== 'financeiro';
  $('#topo').hidden = tela === 'login';
}
function entrar(t, n) {
  token = t; nome = n; primeiraCarga = true;
  try { localStorage.setItem('motoboy_token', t); localStorage.setItem('motoboy_nome', n); } catch { /* sem storage */ }
  $('#topoQuem').textContent = '· ' + n;
  renderBtnSom();
  mostrar('pedidos');
  carregarPedidos();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(carregarPedidos, 10000);
}
function sair(mensagem) {
  token = null; nome = null; ultimoMapa = {}; primeiraCarga = true;
  if (somRepeteTimer) { clearInterval(somRepeteTimer); somRepeteTimer = null; }
  try { localStorage.removeItem('motoboy_token'); localStorage.removeItem('motoboy_nome'); } catch { /* sem storage */ }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (mensagem) { $('#loginErro').textContent = mensagem; $('#loginErro').hidden = false; }
  mostrar('login');
}
$('#formLogin').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#loginErro').hidden = true;
  try {
    const d = await api('/api/motoboy/login', { method: 'POST', body: { login: $('#loginUser').value.trim(), senha: $('#loginPass').value } });
    entrar(d.token, d.nome);
  } catch (err) { $('#loginErro').textContent = err.message; $('#loginErro').hidden = false; }
});
$('#btnSair').addEventListener('click', () => sair());
$('#btnConfig').addEventListener('click', () => {
  $('#chkSomRec').checked = somOn('motoboy_som_recebimento');
  $('#chkSomSaiu').checked = somOn('motoboy_som_saiu');
  $('#senhaErro').hidden = true; $('#senhaOk').hidden = true;
  mostrar('config');
  atualizarPushStatus();
});
$('#btnVoltarPedidos').addEventListener('click', () => mostrar('pedidos'));
$('#btnVoltarPedidosFin').addEventListener('click', () => mostrar('pedidos'));
$('#btnFinanceiro').addEventListener('click', abrirFinanceiro);

/* ---------- Financeiro (v1.16.21) ---------- */
async function abrirFinanceiro() {
  mostrar('financeiro');
  $('#finTotais').innerHTML = '<p class="dica">Carregando…</p>';
  $('#finPagamentos').innerHTML = '';
  try {
    const fin = await api('/api/motoboy/financeiro');
    const valorCfg = fin.modelo === 'por_entrega' ? fin.valor_entrega_centavos : fin.valor_diaria_centavos;
    $('#finModelo').textContent = fin.modelo === 'por_entrega'
      ? (valorCfg ? `Você recebe ${fmtBRL(valorCfg)} por entrega finalizada.` : 'Pagamento por entrega — a loja ainda não definiu o valor.')
      : (valorCfg ? `Você recebe ${fmtBRL(valorCfg)} por dia trabalhado.` : 'Pagamento por diária — a loja ainda não definiu o valor.');
    $('#finTotais').innerHTML = `
      <div class="fin-linha"><span>Entregas finalizadas</span><span>${fin.entregas_finalizadas}</span></div>
      ${fin.modelo === 'diaria' ? `<div class="fin-linha"><span>Dias trabalhados</span><span>${fin.dias_trabalhados}</span></div>` : ''}
      <div class="fin-linha"><span>Total ganho</span><span>${fmtBRL(fin.ganho_centavos)}</span></div>
      <div class="fin-linha"><span>Já recebido</span><span>${fmtBRL(fin.pago_centavos)}</span></div>
      <div class="fin-linha total"><span>A receber</span><span>${fmtBRL(fin.a_receber_centavos)}</span></div>`;
    $('#finPagamentos').innerHTML = fin.pagamentos.length
      ? `<h2 style="font-size:15px;margin-bottom:4px">Pagamentos recebidos</h2>` + fin.pagamentos.map(pg => {
          const d = pg.created_at ? new Date(pg.created_at).toLocaleDateString('pt-BR') : '';
          const detalhe = pg.modelo === 'por_entrega' ? `${pg.entregas_cobertas} entregas` : `${pg.dias_cobertos} dias`;
          return `<div class="fin-pag"><span>${fmtBRL(pg.valor_centavos)}<div class="dica">${detalhe}</div></span><span class="dica">${d}</span></div>`;
        }).join('')
      : '<p class="dica">Nenhum pagamento confirmado ainda.</p>';
  } catch (err) {
    $('#finTotais').innerHTML = `<p class="erro">${esc(err.message)}</p>`;
  }
}
$('#chkSomRec').addEventListener('change', (e) => { try { localStorage.setItem('motoboy_som_recebimento', e.target.checked ? '1' : '0'); } catch { /* sem storage */ } });
$('#chkSomSaiu').addEventListener('change', (e) => { try { localStorage.setItem('motoboy_som_saiu', e.target.checked ? '1' : '0'); } catch { /* sem storage */ } });
$('#formSenha').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#senhaErro').hidden = true; $('#senhaOk').hidden = true;
  const atual = $('#senhaAtual').value, nova = $('#senhaNova').value, conf = $('#senhaConf').value;
  if (nova !== conf) { $('#senhaErro').textContent = 'A senha nova e a confirmação não batem.'; $('#senhaErro').hidden = false; return; }
  try {
    await api('/api/motoboy/senha', { method: 'POST', body: { atual, nova } });
    $('#senhaOk').hidden = false;
    $('#senhaAtual').value = ''; $('#senhaNova').value = ''; $('#senhaConf').value = '';
  } catch (err) { $('#senhaErro').textContent = err.message; $('#senhaErro').hidden = false; }
});

/* ---------- Pedidos ---------- */
function enderecoTexto(p) {
  const e = p.endereco || {};
  const partes = [e.rua && `${e.rua}${e.numero ? ', ' + e.numero : ''}`, e.complemento, p.bairro || e.bairro].filter(Boolean);
  return partes.join(' — ') || 'Endereço não informado';
}
function itensHtml(p) {
  return (p.itens || []).map(it => {
    const ops = (it.opcoes || []).map(op => esc(op.opcao_nome)).join(', ');
    return `<div><strong>${it.quantidade || 1}x ${esc(it.nome_snapshot || it.nome || 'Item')}</strong>${ops ? ` (${ops})` : ''}${it.observacao ? `<div class="obs">OBS: ${esc(it.observacao)}</div>` : ''}</div>`;
  }).join('');
}
function acoesHtml(p) {
  if (!p.motoboy_aceito_em) {
    return `<div class="ped-acao"><button class="btn btn-primario" data-acao="aceitar" data-id="${p.id}">Aceitar entrega</button></div>`;
  }
  if (p.status === 'PRONTO') {
    return `<div class="ped-acao"><button class="btn btn-verde" data-acao="receber" data-id="${p.id}">Confirmar recebimento</button><p class="dica">Ao confirmar, o cliente já vê que saiu para entrega.</p></div>`;
  }
  if (p.status === 'SAIU_ENTREGA') {
    return `<div class="ped-acao"><div class="codigo-row"><input inputmode="numeric" maxlength="4" placeholder="0000" data-codigo="${p.id}"><button class="btn btn-verde" data-acao="entregar" data-id="${p.id}">Confirmar entrega</button></div><p class="dica">Digite o código de 4 dígitos que o cliente informar.</p></div>`;
  }
  return `<p class="dica">Aguardando a loja deixar o pedido pronto.</p>`;
}
function renderPedidos(lista) {
  const box = $('#listaPedidos');
  atualizarSomRepetido(lista);
  if (!lista.length) {
    box.innerHTML = `<div class="vazio"><p><strong>Nenhuma entrega no momento.</strong></p><p class="dica">Quando a loja direcionar um pedido a você, ele aparece aqui.</p></div>`;
    return;
  }
  box.innerHTML = lista.map(p => {
    const tel = String(p.cliente_whatsapp || '').replace(/\D/g, '');
    const troco = (p.forma_pagamento === 'dinheiro' && p.troco_para_centavos && Number(p.troco_para_centavos) > Number(p.total_centavos))
      ? `<div class="troco-box">Troco: <strong>${fmtBRL(Number(p.troco_para_centavos) - Number(p.total_centavos))}</strong> (cliente deu ${fmtBRL(p.troco_para_centavos)})</div>` : '';
    return `<article class="card">
      <div class="ped-top"><span class="ped-num">#${p.numero}</span><span class="chip ${p.status === 'SAIU_ENTREGA' ? 'saiu' : ''}">${STATUS_ROTULO[p.status] || p.status}</span></div>
      <div class="ped-cliente">${esc(p.cliente_nome || 'Cliente')}</div>
      <div class="ped-end">${esc(enderecoTexto(p))}${tel ? ` · <a target="_blank" rel="noopener" href="https://wa.me/${tel}">Chamar no WhatsApp</a>` : ''}</div>
      <div class="ped-itens">${itensHtml(p)}</div>
      ${p.observacao ? `<div class="ped-itens"><div class="obs">OBS do pedido: ${esc(p.observacao)}</div></div>` : ''}
      <div class="ped-totais">
        <div class="linha"><span>Subtotal</span><span>${fmtBRL(p.subtotal_centavos)}</span></div>
        <div class="linha"><span>Taxa de entrega</span><span>${fmtBRL(p.taxa_entrega_centavos)}</span></div>
        ${p.desconto_centavos ? `<div class="linha"><span>Desconto</span><span>− ${fmtBRL(p.desconto_centavos)}</span></div>` : ''}
        <div class="linha total"><span>Total (${esc(p.forma_pagamento || '')})</span><span>${fmtBRL(p.total_centavos)}</span></div>
      </div>
      ${troco}
      ${acoesHtml(p)}
    </article>`;
  }).join('');
  $$('#listaPedidos [data-acao]').forEach(b => b.addEventListener('click', () => acaoPedido(b.dataset.acao, Number(b.dataset.id))));
}
async function acaoPedido(acao, id) {
  try {
    if (acao === 'aceitar') { await api(`/api/motoboy/pedidos/${id}/aceitar`, { method: 'POST' }); }
    if (acao === 'receber') {
      await api(`/api/motoboy/pedidos/${id}/receber`, { method: 'POST' });
      ultimoMapa[id] = 'SAIU_ENTREGA';
      tocar(somSaiu, 'motoboy_som_saiu');
    }
    if (acao === 'entregar') {
      const codigo = ($(`[data-codigo="${id}"]`) || {}).value || '';
      await api(`/api/motoboy/pedidos/${id}/entregar`, { method: 'POST', body: { codigo } });
    }
    await carregarPedidos();
  } catch (err) { alert(err.message); }
}
async function carregarPedidos() {
  if (!token) return;
  try {
    const lista = await api('/api/motoboy/pedidos');
    const novoMapa = {};
    lista.forEach(p => { novoMapa[p.id] = p.status; });
    // Sons: pedido novo na lista = recebimento; virou SAIU_ENTREGA = saída.
    // A primeira carga é silenciosa (ele já está olhando a tela) — o som
    // vale para o que CHEGA depois.
    if (!primeiraCarga) {
      Object.keys(novoMapa).forEach(id => {
        if (!(id in ultimoMapa)) tocar(somRec, 'motoboy_som_recebimento');
        else if (ultimoMapa[id] !== 'SAIU_ENTREGA' && novoMapa[id] === 'SAIU_ENTREGA') tocar(somSaiu, 'motoboy_som_saiu');
      });
    }
    primeiraCarga = false;
    ultimoMapa = novoMapa;
    renderPedidos(lista);
    $('#atualizadoEm').textContent = 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch (err) {
    if (err.status === 401) sair('Sessão expirada. Entre de novo.');
  }
}

/* Boot */
if (token && nome) {
  $('#topoQuem').textContent = '· ' + nome;
  renderBtnSom();
  mostrar('pedidos');
  carregarPedidos();
  pollTimer = setInterval(carregarPedidos, 10000);
} else {
  renderBtnSom();
  mostrar('login');
}
