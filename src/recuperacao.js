'use strict';
// Recuperação de senha COM APROVAÇÃO (v1.9.22) — desenho do Gabriel:
//   1) Na tela de login, a pessoa informa o usuário e envia o pedido.
//   2) O ADM é avisado na hora (Telegram + push do painel).
//   3) O ADM gera uma senha TEMPORÁRIA no painel (Equipe) e passa à pessoa.
//   4) A pessoa entra com a temporária e o painel OBRIGA a trocar na hora.
// A temporária só aparece UMA vez (na resposta de quem gerou) — no banco
// fica só o hash, como qualquer senha. Pedido repetido não duplica: vale
// 1 pendente por usuário, por 24h.
const { get, all, run, execSql, modoBanco } = require('./db');
const util = require('./util');
const notif = require('./notificacoes');
const pushPainel = require('./push');

async function criarTabelas() {
  const col = modoBanco() === 'sqlite'
    ? 'ALTER TABLE usuarios ADD COLUMN precisa_trocar_senha INTEGER DEFAULT 0'
    : 'ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS precisa_trocar_senha INTEGER DEFAULT 0';
  try { await execSql(col); } catch { /* SQLite sem IF NOT EXISTS: já existe */ }
  if (modoBanco() === 'sqlite') {
    await execSql(`
CREATE TABLE IF NOT EXISTS recuperacao_senha (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',
  criado_em TEXT DEFAULT (datetime('now')),
  atendido_em TEXT,
  atendido_por TEXT
);
`);
  } else {
    await execSql(`
CREATE TABLE IF NOT EXISTS recuperacao_senha (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',
  criado_em TIMESTAMPTZ DEFAULT now(),
  atendido_em TIMESTAMPTZ,
  atendido_por TEXT
);
`);
  }
}

async function preparar() {
  try { await criarTabelas(); }
  catch (e) { console.error('[recuperacao] preparar:', e.message); }
}

// Passo 1 (público): registra o pedido e avisa o ADM. A resposta ao cliente
// é sempre genérica (não confirma se o usuário existe).
async function criarPedido(loginBruto) {
  const login = String(loginBruto || '').trim();
  if (!login) return { ok: true };
  const u = await get('SELECT * FROM usuarios WHERE LOWER(login)=LOWER(?) AND ativo=1', login);
  if (!u) return { ok: true };
  // Expira pendentes velhas (>24h) e evita duplicar pedido aberto — a conta
  // de tempo é em JS para valer igual nos dois bancos (formatos diferentes).
  const abertos = await all("SELECT * FROM recuperacao_senha WHERE usuario_id=? AND status='pendente'", u.id);
  for (const a of abertos) {
    const txt = String(a.criado_em || '');
    const criado = new Date(txt.replace(' ', 'T') + (/Z|[+-]\d{2}:?\d{2}$/.test(txt) ? '' : 'Z'));
    if (!isNaN(criado) && Date.now() - criado.getTime() > 24 * 3600 * 1000) {
      await run("UPDATE recuperacao_senha SET status='expirada' WHERE id=?", a.id);
    } else {
      return { ok: true }; // já existe um pedido válido esperando o ADM
    }
  }
  await run('INSERT INTO recuperacao_senha (usuario_id) VALUES (?)', u.id);
  try {
    await notif.notificarDonoTexto(`🔑 *Recuperação de senha:* ${notif.escMd(u.nome)} (usuário ${notif.escMd(u.login)}) pediu uma nova senha.\nGere a temporária no painel: Equipe → Recuperação de senha.`);
  } catch { /* Telegram é um dos canais; o pedido está salvo no painel */ }
  try {
    await pushPainel.enviarParaTodos({
      titulo: 'Recuperação de senha',
      corpo: `${u.nome} pediu uma nova senha — gere a temporária em Equipe.`,
      url: '/painel', tag: 'recuperacao-senha',
    });
  } catch { /* idem */ }
  return { ok: true };
}

async function listar() {
  return all(`SELECT r.*, u.nome, u.login, u.perfil
    FROM recuperacao_senha r JOIN usuarios u ON u.id = r.usuario_id
    ORDER BY (r.status = 'pendente') DESC, r.id DESC LIMIT 30`);
}

// Núcleo: aplica a temporária num usuário (hash novo, troca obrigatória,
// sessões encerradas) e devolve o texto dela — usado pelos dois caminhos.
async function aplicarTemporaria(u) {
  const alfabeto = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let temp = '';
  const bytes = require('crypto').randomBytes(10);
  for (let i = 0; i < 10; i++) temp += alfabeto[bytes[i] % alfabeto.length];
  await run('UPDATE usuarios SET senha_hash=?, precisa_trocar_senha=1 WHERE id=?', util.hashSenha(temp), u.id);
  await run('DELETE FROM sessoes WHERE usuario_id=?', u.id);
  return temp;
}

// Passo 3 (ADM): gera a temporária de um pedido pendente.
async function gerar(id, adminNome) {
  const r = await get('SELECT * FROM recuperacao_senha WHERE id=?', id);
  if (!r) return { ok: false, erro: 'Pedido não encontrado.' };
  if (r.status !== 'pendente') return { ok: false, erro: 'Este pedido já foi resolvido.' };
  const u = await get('SELECT * FROM usuarios WHERE id=? AND ativo=1', r.usuario_id);
  if (!u) return { ok: false, erro: 'Usuário desativado ou removido.' };
  const temp = await aplicarTemporaria(u);
  await run("UPDATE recuperacao_senha SET status='atendida', atendido_em=datetime('now'), atendido_por=? WHERE id=?", adminNome || 'Administrador', id);
  return { ok: true, temporaria: temp, nome: u.nome, login: u.login };
}

// E se o ADM esquecer a própria senha? (v1.9.24) — ele se recupera pelo
// Telegram: o chat do dono é a identidade verificada dele no sistema.
// Gera a temporária do administrador principal e registra a auditoria
// como um pedido autoatendido.
async function recuperarAdmin() {
  const u = await get("SELECT * FROM usuarios WHERE perfil='admin' AND ativo=1 ORDER BY id LIMIT 1");
  if (!u) return { ok: false, erro: 'Nenhum administrador ativo encontrado.' };
  const info = await run('INSERT INTO recuperacao_senha (usuario_id) VALUES (?)', u.id);
  const temp = await aplicarTemporaria(u);
  await run("UPDATE recuperacao_senha SET status='atendida', atendido_em=datetime('now'), atendido_por=? WHERE id=?",
    'Ele mesmo (Telegram)', Number(info && info.lastInsertRowid));
  return { ok: true, temporaria: temp, nome: u.nome, login: u.login };
}

async function cancelar(id) {
  const r = await get('SELECT * FROM recuperacao_senha WHERE id=?', id);
  if (!r || r.status !== 'pendente') return { ok: false, erro: 'Pedido já resolvido.' };
  await run("UPDATE recuperacao_senha SET status='cancelada' WHERE id=?", id);
  return { ok: true };
}

module.exports = { preparar, criarPedido, listar, gerar, cancelar, recuperarAdmin };
