'use strict';
// Robô de atendimento no WhatsApp (v1.15.0) — o "coração" da Anota AI e da
// Multipedidos, no nosso desenho: robô REATIVO (só responde quem chamou),
// conversa guiada por menu e NUNCA monta pedido na conversa — sempre empurra
// pro cardápio, onde o cliente monta sem erro de anotação.
//
// Entrada: webhook da Evolution (POST /api/webhooks/whatsapp) resolve a loja
// pela instância e chama tratarMensagem dentro do contexto da loja.
// Saída: fila de notificações (canal whatsapp) — Evolution quando houver;
// sem Evolution, fica registrado como "simulado", igual aos outros avisos.
const { get, all, run, execSql, modoBanco } = require('./db');
const tenant = require('./tenant');
const { normalizaFone, lojaEstaAberta, fmtBRL } = require('./util');
const notif = require('./notificacoes');

const lid = () => tenant.lojaId();

const SAUDACAO_PADRAO = 'Oi! 👋 Aqui é da {loja}. Como posso te ajudar?';

async function criarTabelas() {
  const comum = `
CREATE TABLE IF NOT EXISTS whats_sessoes (
  id ${modoBanco() === 'sqlite' ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'SERIAL PRIMARY KEY'},
  loja_id INTEGER NOT NULL DEFAULT 1,
  whatsapp TEXT NOT NULL,
  ultima_saudacao_em ${modoBanco() === 'sqlite' ? 'TEXT' : 'TIMESTAMPTZ'},
  silenciado_ate ${modoBanco() === 'sqlite' ? 'TEXT' : 'TIMESTAMPTZ'},
  atualizado_em ${modoBanco() === 'sqlite' ? "TEXT DEFAULT (datetime('now'))" : 'TIMESTAMPTZ DEFAULT now()'}
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_whats_sessoes ON whats_sessoes (loja_id, whatsapp);
CREATE TABLE IF NOT EXISTS config_robo (
  id INTEGER PRIMARY KEY,
  loja_id INTEGER NOT NULL DEFAULT 1,
  ativo INTEGER NOT NULL DEFAULT 1,
  saudacao TEXT,
  silencio_horas INTEGER NOT NULL DEFAULT 24
);
`;
  await execSql(comum);
}

async function preparar() {
  try {
    await criarTabelas();
    await run(`INSERT OR IGNORE INTO config_robo (id, loja_id) VALUES (${lid()}, ${lid()})`);
  } catch (e) { console.error('[whats-robo] preparar:', e.message); }
}

async function getConfig() {
  const c = (await get(`SELECT * FROM config_robo WHERE id=${lid()}`)) || {};
  return {
    ativo: c.ativo === undefined ? true : !!c.ativo,
    saudacao: c.saudacao || SAUDACAO_PADRAO,
    silencio_horas: Math.min(72, Math.max(1, Number(c.silencio_horas) || 24)),
  };
}

async function salvarConfig(dados) {
  const atual = await getConfig();
  const prox = {
    ativo: dados.ativo !== undefined ? (dados.ativo ? 1 : 0) : (atual.ativo ? 1 : 0),
    saudacao: dados.saudacao !== undefined ? String(dados.saudacao || '').trim().slice(0, 300) || null : null,
    silencio_horas: dados.silencio_horas !== undefined
      ? Math.min(72, Math.max(1, Number(dados.silencio_horas) || 24)) : atual.silencio_horas,
  };
  await run(`INSERT INTO config_robo (id, loja_id, ativo, saudacao, silencio_horas)
    VALUES (${lid()}, ${lid()}, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET ativo=excluded.ativo, saudacao=excluded.saudacao, silencio_horas=excluded.silencio_horas`,
    prox.ativo, prox.saudacao, prox.silencio_horas);
  return getConfig();
}

// Qual loja é dona desta instância Evolution? (o webhook resolve por aqui)
async function lojaDaInstancia(instancia) {
  if (!instancia) return null;
  const r = await get('SELECT loja_id, evolution_apikey FROM config_notificacoes WHERE evolution_instancia=?', String(instancia));
  return r || null;
}

const semAcento = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const contem = (t, lista) => lista.some(p => t.includes(p));

function linkDaLoja(loja, host) {
  if (loja && loja.dominio) return 'https://' + String(loja.dominio).replace(/^https?:\/\//, '');
  if (host) return 'https://' + host;
  return '';
}

async function sessao(w) {
  let s = await get(`SELECT * FROM whats_sessoes WHERE loja_id=${lid()} AND whatsapp=?`, w);
  if (!s) {
    await run(`INSERT INTO whats_sessoes (loja_id, whatsapp) VALUES (${lid()}, ?)`, w);
    s = await get(`SELECT * FROM whats_sessoes WHERE loja_id=${lid()} AND whatsapp=?`, w);
  }
  return s;
}

const instante = (v) => {
  if (!v) return null;
  const s = String(v);
  const d = new Date(s.includes('T') || s.includes('+') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d;
};

async function enviar(w, texto) {
  await notif.enfileirar({ canal: 'whatsapp', destino: w, corpo: texto });
}

function textoMenu(loja, cfg, estado) {
  const saud = cfg.saudacao.replaceAll('{loja}', loja.nome || 'loja');
  const aberto = estado.aberta
    ? '🟢 Estamos abertos agora!'
    : `🔴 ${estado.mensagem || 'Estamos fechados no momento.'}`;
  return `${saud}

${aberto}

*1* — Ver o cardápio e fazer um pedido
*2* — Horário de funcionamento
*3* — Taxa de entrega
*4* — Falar com a loja

É só responder com o número, ou escrever o que procura (ex.: "cardápio").`;
}

async function pedidoAtivo(w) {
  return (await get(`SELECT id, numero, token, status FROM pedidos
    WHERE loja_id=${lid()} AND cliente_whatsapp=? AND status NOT IN ('ENTREGUE','CANCELADO')
    ORDER BY id DESC LIMIT 1`, w)) || null;
}

const ROTULO_STATUS = {
  NOVO: 'recebido — aguardando a loja confirmar',
  EM_PREPARO: 'em preparo 👨‍🍳',
  PRONTO: 'pronto ✅',
  SAIU_ENTREGA: 'saiu pra entrega 🛵',
};

// O coração do robô. Retorna { acao } pra teste/log; as respostas saem pela
// fila de notificações. Nunca lança: webhook não pode quebrar.
async function tratarMensagem({ de, texto, nome, host }) {
  try {
    const cfg = await getConfig();
    if (!cfg.ativo) return { acao: 'desligado' };
    const w = normalizaFone(de);
    if (!w || w.length < 12) return { acao: 'ignorado' };
    const s = await sessao(w);
    const agora = new Date();
    const silenciadoAte = instante(s.silenciado_ate);
    if (silenciadoAte && silenciadoAte > agora) return { acao: 'silenciado' };

    const loja = (await get(`SELECT * FROM lojas WHERE id=${lid()}`)) || {};
    const estado = lojaEstaAberta(loja);
    const link = linkDaLoja(loja, host);
    const t = semAcento(texto);

    const ehAtendente = t === '4' || contem(t, ['atendente', 'humano', 'falar com alguem', 'falar com a loja', 'pessoa de verdade']);
    const ehStatus = contem(t, ['meu pedido', 'andamento', 'status do pedido', 'cade meu', 'cade o pedido', 'chega quando', 'saiu pra entrega', 'rastrear']);
    const ehCardapio = t === '1' || contem(t, ['cardapio', 'menu', 'ver o cardapio', 'fazer um pedido', 'fazer pedido', 'quero pedir', 'quero comprar']);
    const ehHorario = t === '2' || contem(t, ['horario', 'funcionamento', 'que horas', 'abre', 'fecha', 'aberto agora']);
    const ehTaxa = t === '3' || contem(t, ['taxa de entrega', 'taxa', 'frete', 'valor da entrega', 'entregam ai', 'faz entrega', 'fazem entrega']);

    if (ehAtendente) {
      const ate = new Date(agora.getTime() + cfg.silencio_horas * 3600 * 1000);
      await run(`UPDATE whats_sessoes SET silenciado_ate=?, atualizado_em=datetime('now') WHERE id=?`,
        ate.toISOString().replace('T', ' ').slice(0, 19), s.id);
      await enviar(w, 'Beleza! Já chamei a loja aqui — em instantes alguém te responde por aqui mesmo. 👍\n\n(Enquanto isso, se quiser adiantar, nosso cardápio é este: ' + link + ')');
      try {
        await notif.notificarDonoTexto(`🙋 *WhatsApp:* o cliente ${nome || w} (${w}) pediu pra falar com a loja. O robô silenciou por ${cfg.silencio_horas}h nesse número — responde ele por lá.`);
      } catch { /* aviso é bônus */ }
      return { acao: 'atendente' };
    }
    if (ehStatus) {
      const p = await pedidoAtivo(w);
      if (p) {
        await enviar(w, `Seu pedido *#${p.numero}* está: ${ROTULO_STATUS[p.status] || p.status}.\n\nAcompanhe ao vivo aqui: ${link}/pedido/${p.token}`);
      } else {
        await enviar(w, 'Você não tem nenhum pedido em andamento agora. 😊\n\nQuer fazer um? É só tocar aqui: ' + link);
      }
      return { acao: 'status' };
    }
    if (ehCardapio) {
      await enviar(w, `Perfeito! 🎉 É só tocar no link e montar seu pedido — ele cai direto na nossa tela e você acompanha tudo por aqui:\n\n👉 ${link}\n\nLeva um minutinho. Qualquer dúvida é só chamar!`);
      return { acao: 'cardapio' };
    }
    if (ehHorario) {
      await enviar(w, `Nosso horário de funcionamento é das *${loja.horario_abre || '—'}* às *${loja.horario_fecha || '—'}*.\n\n${estado.aberta ? 'E estamos abertos agora! 🟢 Pra pedir: ' + link : 'No momento estamos fechados. 🔴'}`);
      return { acao: 'horario' };
    }
    if (ehTaxa) {
      if (loja.taxa_unica_centavos != null) {
        await enviar(w, Number(loja.taxa_unica_centavos) === 0
          ? 'Temos *entrega grátis*! 🎉 É só pedir pelo cardápio: ' + link
          : `Nossa taxa de entrega é *${fmtBRL(loja.taxa_unica_centavos)}*.\n\nPra fazer seu pedido: ${link}`);
      } else {
        await enviar(w, `A taxa depende do bairro — no fechamento do pedido ela aparece certinha pro seu endereço. 😉\n\nÉ só montar aqui: ${link}`);
      }
      return { acao: 'taxa' };
    }
    // Qualquer outra coisa (oi, bom dia, áudio, foto...): manda o menu — mas
    // no máximo 1 vez por hora pra não virar robô chato em conversa aberta.
    const ultima = instante(s.ultima_saudacao_em);
    if (ultima && agora - ultima < 3600 * 1000) return { acao: 'menu-recente' };
    await run(`UPDATE whats_sessoes SET ultima_saudacao_em=datetime('now'), atualizado_em=datetime('now') WHERE id=?`, s.id);
    await enviar(w, textoMenu(loja, cfg, estado));
    return { acao: 'menu' };
  } catch (e) {
    console.error('[whats-robo] tratarMensagem:', e.message);
    return { acao: 'erro' };
  }
}

module.exports = { preparar, getConfig, salvarConfig, lojaDaInstancia, tratarMensagem, SAUDACAO_PADRAO };
