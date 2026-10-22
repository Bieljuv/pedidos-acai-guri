-- RESET COMPLETO — Açaí do Guri (Supabase)
-- Apaga TODOS os dados (pedidos de teste, cardápio de exemplo, configurações)
-- e deixa o banco vazio. Na próxima subida do sistema (npm start ou novo
-- deploy), o seed novo entra sozinho: cardápio real, combos, loja e o
-- login admin/admin123.
-- Rode no SQL Editor do projeto AçaiDoGuri e depois reinicie o sistema.
TRUNCATE TABLE
  lojas, usuarios, sessoes, categorias, produtos, grupos_opcoes, opcoes,
  produto_grupos, bairros, clientes, pedidos, pedido_itens,
  pedido_item_opcoes, pedido_status_historico, notificacoes, impressoes,
  config_recebimentos, pagamentos, fin_lancamentos, fin_insumos,
  config_notificacoes, pontos, config_entregadores, entregas
RESTART IDENTITY CASCADE;
