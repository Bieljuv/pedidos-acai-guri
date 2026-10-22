# CONTRATO — v1.9.2: reaproveitar a edição externa (ícones + módulo 99 completo)

Gabriel aprovou reaproveitar "praticamente tudo" da cópia editada que ele
mandou revisar, "principalmente o capricho do layout". Os arquivos-fonte
estão em `/tmp/revisao/pedidos-acai-guri/` (NÃO estão no git):
`public/icons.js`, `src/entregadores.js`, `api/index.js`.
Os scripts `tmp-check.js`/`tmp-e2e.js` são restos de teste — NÃO importar.

## A. Ícones: adotar o sprite da edição como sistema oficial
- Copiar `public/icons.js` pro projeto (sprite SVG com ~55 símbolos
  desenhados à mão + helper global `window.ic(nome)` via `<use>`).
- Loja, acompanhamento e painel passam a usar ESSE sistema: incluir
  `icons.js` nas páginas e trocar as definições inline atuais
  (helpers `ic()` locais da v1.9) por chamadas ao sprite, mapeando os
  nomes (ex.: receipt→receipt/i-receipt conforme a API do arquivo —
  seguir o padrão `window.ic` dele). Símbolos que a v1.9 usa e o sprite
  não tem entram COMO SÍMBOLOS NOVOS no próprio icons.js (mesmo traço
  1.7/1.8, viewBox 24) — inclusive a **moto de Bairros e Taxas**: usar o
  `i-scooter` do sprite lá (é o ícone de entrega do conjunto aprovado).
- Resultado visual não pode regredir: mesmos lugares, mesmos tamanhos
  (classe `.ic` com width/height atuais), claro e escuro.

## B. 99: `entregadores.js` vira O módulo oficial (aposenta o entrega99.js)
- Copiar `src/entregadores.js` pro projeto e LIGAR de verdade:
  - `preparar()` chamado no boot (cria `config_entregadores` e `entregas`
    nos dois bancos — conferir/adaptar o DDL pra Postgres: o arquivo foi
    escrito com ramo sqlite; o PG precisa dos mesmos CREATE TABLE IF NOT
    EXISTS via preparar, e schema.sql/reset atualizados).
  - Rotas no server.js (só admin, padrão atual): GET/PUT da configuração
    (segredos mascarados — cfgPublica/mascarar do módulo), POST testar.
  - No pedido (detalhe do painel): **Despachar 99** (entrega em
    EM_PREPARO/PRONTO), **Consultar status**, **Cancelar entrega** —
    usando despachar/consultar/cancelar do módulo; o histórico
    (`entregasDoPedido`) aparece no detalhe do pedido com os rótulos
    pt-BR do módulo (traduzirStatus99/rotuloStatus).
  - **Webhook público** `POST /api/webhooks/entregas/99` →
    tratarWebhook (registrar a entrega/status; sem auth de sessão —
    validar formato e ignorar payload inválido com 200).
  - **Sem credenciais ativas** → manter o comportamento da v1.9:
    **despacho manual** registrado (coleta/destino/telefone/PIN prontos
    pra copiar) — registrar na tabela `entregas` com status 'manual'.
  - O **PIN é o codigo_entrega** (o montarPayload99 do módulo já o usa
    como order.number — conferir e manter).
  - A tela de Configurações "Entregador 99" passa a editar a
    config_entregadores (client_id, client_secret mascarado, merchant,
    endereço/telefone de coleta, ativo) + guia de obtenção das
    credenciais (99 Empresas). A config antiga da v1.9 (token único no
    config geral) é aposentada: remover a seção/campos do entrega99 e
    apagar `src/entrega99.js` (git rm) — nada de dois módulos 99.
  - Falha ao despachar NUNCA trava o pedido (regra do próprio módulo) —
    erro claro no painel, pedido segue o fluxo normal.
- Os endpoints/base do módulo são placeholders documentados (a spec
  oficial vem com as credenciais de parceiro) — manter o ponto único de
  ajuste (api99/montarPayload99) e NÃO inventar respostas: sem
  credenciais, nada de chamada externa.

## C. api/index.js
- Copiar como está (shim serverless da Vercel: exporta o app sem listen).
  Conferir que `require('../server')` não quebra o boot local (server.js
  exporta o app? se ele só dá listen sem exportar, ajustar a exportação
  sem mudar o comportamento local).

## Aceite (evidência obrigatória)
1. Prints claro/escuro (loja, painel, detalhe do pedido): ícones do
   sprite em tudo (Bairros e Taxas com a scooter), zero emoji, nenhum
   ícone faltando/quebrado (varrer as telas principais no Playwright).
2. Config 99 salva e mascara (client_secret não vaza no GET); testar sem
   credencial → resposta amigável, sem 500.
3. Despacho sem credencial → 'manual' registrado e exibido no histórico
   do pedido com o PIN; despacho com API stub local (apontar a base pra
   um servidor falso) → entrega criada, status consultado e traduzido,
   cancelar funciona, webhook atualiza a entrega.
4. Regressão: v1.9 (código de entrega, tema), v1.9.1 (autoria), v1.8
   (ponto/perfis), v1.7 (relatórios) — suíte verde; node --check limpo;
   migrations idempotentes nos dois bancos (SQLite ao vivo; PG por
   schema/preparar espelhados).
5. entrega99.js removido; grep por "entrega99" no código = 0 (exceto
   histórico/migração justificado).
