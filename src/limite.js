'use strict';
// Limitador de tentativas em memória (v1.9.28 — pacote blindagem).
// Em serverless cada instância conta a sua parte: não é uma muralha,
// mas freia o abuso em rajada (robô testando senha, spam de notificação).
// As regras DURÁVEIS (ex.: 1 pedido de recuperação por usuário/24h)
// continuam gravadas no banco.

const acertos = new Map(); // chave -> [timestamps] (conta toda chamada)
const falhas = new Map();  // chave -> [timestamps] (conta só falhas)

function podar(mapa, chave, janelaMs, agora) {
  const lista = (mapa.get(chave) || []).filter((t) => agora - t < janelaMs);
  if (lista.length) mapa.set(chave, lista); else mapa.delete(chave);
  return lista;
}

// true se a chamada é permitida (e registra). Usar em rotas públicas.
function permitido(chave, max, janelaMs) {
  const agora = Date.now();
  const lista = podar(acertos, chave, janelaMs, agora);
  if (lista.length >= max) return false;
  lista.push(agora);
  acertos.set(chave, lista);
  return true;
}

// Para o login: pergunta ANTES, registra a falha, limpa no sucesso.
function bloqueado(chave, max, janelaMs) {
  return podar(falhas, chave, janelaMs, Date.now()).length >= max;
}
function falhou(chave) {
  const lista = falhas.get(chave) || [];
  lista.push(Date.now());
  falhas.set(chave, lista);
}
function limparFalhas(chave) { falhas.delete(chave); }

function ipDe(req) {
  const fwd = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return fwd || req.ip || 'sem-ip';
}

module.exports = { permitido, bloqueado, falhou, limparFalhas, ipDe };
