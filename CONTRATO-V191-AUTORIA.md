# CONTRATO — v1.9.1: quem fez cada passo do pedido (trilha de autoria)

Pedido do Gabriel (22/10 06:33): marcar NO PEDIDO e NO SISTEMA quem
confirmou cada passo até o recebimento/entrega — não só a última pessoa.

## Estado atual (verificado)
- `pedidos.atualizado_por` guarda só o ÚLTIMO ator.
- `pedido_status_historico` já registra cada transição (de/para, origem,
  motivo, quando) — mas SEM o nome de quem fez.

## O que fazer
1. Coluna `autor` em `pedido_status_historico` (migration idempotente
   nos dois bancos + schema.sql + reset). `transicionar()` grava o autor
   em TODA transição:
   - Painel: nome do usuário da sessão (admin ou funcionário).
   - Telegram: nome do dono (usuário admin) + sufixo "(Telegram)".
   - Sistema/pagamento (webhooks etc.): "Sistema" quando não houver ator
     humano.
   - Criação do pedido: linha inicial no histórico — para=NOVO,
     autor="Cliente (site)".
2. **Detalhe do pedido no painel**: a linha do tempo passa a mostrar cada
   passo completo: **o quê, quem, quando e por onde** — ex.:
   "Confirmado — Maria Silva — 14:32 (painel)", "Saiu para entrega —
   Gabriel (Telegram) — 15:05", "Entregue — código conferido — Admin".
   Linhas antigas sem autor mostram só origem/canal (sem quebrar).
3. **Cartão do pedido (board)**: manter o "último movimento por X" já
   existente (atualizado_por) — sem mudança.
4. A trilha é **somente leitura** (ninguém edita histórico).

## Aceite
- Pedido de teste atravessando painel + Telegram: o histórico lista cada
  passo com autor e horário corretos, na ordem.
- Pedido antigo (pré-v1.9.1) abre o detalhe sem erro e sem autor nas
  linhas velhas.
- Regressão: transições e relatórios intactos; node --check limpo;
  migrations idempotentes nos dois bancos.
