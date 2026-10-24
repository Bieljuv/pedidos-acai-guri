'use strict';
const crypto = require('crypto');

const fmtBRL = (cent) => 'R$ ' + (Number(cent || 0) / 100).toFixed(2).replace('.', ',');
const agora = () => new Date().toISOString();
const tokenAleatorio = (bytes = 18) => crypto.randomBytes(bytes).toString('hex');
/* Codigo curto do pedido (v1.16.17): o link de acompanhamento usa o token
   do pedido — 36 hex era feio de compartilhar no WhatsApp. Codigo de 6
   caracteres, sem 0/O/1/I (nao confundem na leitura), sorteado com
   crypto. Continua ALEATORIO (nao e numero sequencial: numero sequencial
   deixaria qualquer um enumerar pedidos alheios, e o acompanhamento
   expoe nome, telefone e endereco). */
const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const codigoPedido = () => Array.from({ length: 6 }, () => ALFABETO_CODIGO[crypto.randomInt(ALFABETO_CODIGO.length)]).join('');

function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(senha), salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function verificaSenha(senha, guardado) {
  try {
    const [saltHex, hashHex] = String(guardado).split(':');
    const esperado = Buffer.from(hashHex, 'hex');
    const calc = crypto.scryptSync(String(senha), Buffer.from(saltHex, 'hex'), 64);
    return crypto.timingSafeEqual(esperado, calc);
  } catch { return false; }
}

// Carrega .env simples (sem dependência) — só define o que ainda não existe no ambiente.
function carregarEnv(arquivo) {
  const fs = require('fs');
  try {
    for (const linha of fs.readFileSync(arquivo, 'utf8').split('\n')) {
      const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* sem .env, tudo bem */ }
}

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
function normalizaFone(s) {
  let d = soDigitos(s);
  if (d && !d.startsWith('55')) d = '55' + d;
  return d;
}

// Mascara credencial para exibição: "••••••••a1b2"
function mascarar(valor) {
  if (!valor) return '';
  const v = String(valor);
  return '••••••••' + v.slice(-4);
}
const ehMascarado = (v) => typeof v === 'string' && v.includes('•');

function lojaEstaAberta(loja) {
  if (!loja) return { aberta: false, pausada: false, mensagem: 'Loja não encontrada.' };
  const agoraDate = new Date();
  if (loja.pausada_ate && new Date(loja.pausada_ate) > agoraDate) {
    return { aberta: false, pausada: true, mensagem: 'Loja pausada no momento. Voltamos já!' };
  }
  if (!loja.aberta_manual) return { aberta: false, pausada: false, mensagem: 'Loja fechada no momento.' };
  // horário SEMPRE em America/Sao_Paulo: a loja é no Brasil, mas o servidor
  // pode rodar em UTC (ex.: Vercel) — usar o fuso da máquina quebrava o abre/fecha.
  const hhmm = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(agoraDate);
  const abre = loja.horario_abre || '00:00', fecha = loja.horario_fecha || '23:59';
  const dentro = abre <= fecha ? (hhmm >= abre && hhmm <= fecha) : (hhmm >= abre || hhmm <= fecha);
  if (!dentro) return { aberta: false, pausada: false, mensagem: `Fechado agora — abrimos às ${abre}.` };
  return { aberta: true, pausada: false, mensagem: 'Aberto agora' };
}

/* Corte de pedidos (v1.16.14): a loja para de aceitar pedidos N minutos
   antes de fechar (config aviso_fechar_minutos), para a cozinha despachar
   as ultimas entregas antes do fechamento. Retorna a mensagem de corte
   quando agora esta na janela [fechamento - N, fechamento], senao null.
   So vale com o aviso ligado; com ele desligado a loja aceita ate fechar.
   Horario em America/Sao_Paulo, igual ao lojaEstaAberta. */
function msgCortePedidos(loja) {
  if (!loja || loja.aviso_fechar_ativo === 0 || loja.aviso_fechar_ativo === false) return null;
  const minutos = Number(loja.aviso_fechar_minutos) || 30;
  const fecha = loja.horario_fecha || '23:59', abre = loja.horario_abre || '00:00';
  const hhmm = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const paraMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  let ateFechar = paraMin(fecha) - paraMin(hhmm);
  if (ateFechar < 0) ateFechar += 1440; // fecha depois da meia-noite (ex.: abre 18h, fecha 02h)
  if (ateFechar > minutos) return null;
  return `Infelizmente já encerramos os pedidos de hoje — a cozinha precisa despachar as últimas entregas antes do fechamento, às ${String(fecha).slice(0, 5)}. Voltamos amanhã às ${String(abre).slice(0, 5)}!`;
}

module.exports = { fmtBRL, agora, tokenAleatorio, codigoPedido, hashSenha, verificaSenha, carregarEnv, soDigitos, normalizaFone, mascarar, ehMascarado, lojaEstaAberta, msgCortePedidos };
