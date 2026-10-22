# CONTRATO — v1.7: Relatório mensal + XML contabilidade + lucro real melhorado

Ideias do primo (via Gabriel):
1. **Relatório mensal** exportável em **XML pra contabilidade**.
2. Confirmação automática no WhatsApp ao confirmar o pedido — **JÁ EXISTE**
   (msgClienteStatus NOVO = "recebemos seu pedido"; EM_PREPARO = "confirmado,
   já estamos preparando"; dispara na transição, venha do painel ou do
   Telegram). NADA a fazer aqui — não mexer nas notificações.
3. **Melhorar o cálculo de lucro real** — ver seção A.

## A. Cálculo por período + lucro em duas camadas (src/financeiro.js)

Hoje: `calcular(data)` (um dia) é a fonte única de /financeiro/calculo e do PDF.

- Generalizar para `calcularPeriodo(de, ate)` ('YYYY-MM-DD' inclusivo, mesma
  semântica de fuso atual: `date(created_at,'localtime')` entre de/ate).
  `calcular(data)` vira wrapper (de=ate=data) — comportamento e números do
  dia NÃO mudam.
- Fontes idênticas às de hoje (espelhar o que calcular() já soma: vendas
  ENTREGUE, receita_manual de fin_lancamentos, insumos de fin_insumos,
  despesas e investimento de fin_lancamentos, copos da mesma contagem atual).
- Novos campos no retorno (além de todos os atuais):
  - `lucro_operacional_centavos` = receita_total − (insumos + despesas)
    → é o lucro das VENDAS, sem o investimento distorcer.
  - `investimento_centavos` continua retornado separado.
  - `lucro_real_centavos` MANTÉM a definição atual (receita_total − custo_total,
    custo_total inclui investimento) = "resultado final após investimentos".
  - custo_por_copo/preco_medio/lucro_por_copo recalculados sobre o período
    (mesmas fórmulas, denominador = copos do período).
- Endpoint atual `GET /api/painel/financeiro/calculo?data=` continua; aceitar
  também `?de=&ate=` (se vierem, têm prioridade).

## B. Relatório mensal (server.js + painel)

- `GET /api/painel/relatorio/mensal?mes=YYYY-MM` (auth) →
  `{ mes, dias: [{ data, pedidos_concluidos, pedidos_cancelados,
  faturamento_centavos, ticket_medio_centavos }], totais: { pedidos_concluidos,
  pedidos_cancelados, faturamento_centavos, ticket_medio_centavos },
  por_pagamento: [{ forma, qtd, total_centavos }],
  financeiro: <calcularPeriodo(primeiro, ultimo dia do mês)> }`
  (faturamento/ticket seguem a definição do relatório diário atual: pedidos
  ENTREGUE; por_pagamento idem, agrupado por forma_pagamento).
- `GET /api/painel/relatorio/mensal/xml?mes=YYYY-MM` (auth) → download
  `relatorio-acai-YYYY-MM.xml`, `Content-Type: application/xml; charset=utf-8`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<relatorio_mensal loja="Açaí do Guri" mes="YYYY-MM" moeda="BRL" gerado_em="ISO">
  <resumo faturamento_centavos="" pedidos_concluidos="" pedidos_cancelados=""
    ticket_medio_centavos="" receitas_manuais_centavos="" insumos_centavos=""
    despesas_centavos="" investimentos_centavos=""
    lucro_operacional_centavos="" lucro_real_centavos=""/>
  <vendas>
    <pedido numero="" data="YYYY-MM-DD HH:MM:SS" cliente="" tipo="entrega|retirada"
      forma_pagamento="" status="ENTREGUE|CANCELADO|..." subtotal_centavos=""
      taxa_entrega_centavos="" total_centavos=""/>
    <!-- todos os pedidos do mês, com status -->
  </vendas>
  <lancamentos>
    <lancamento data="" tipo="insumo|despesa|investimento|receita_manual"
      descricao="" valor_centavos=""/>
    <!-- fin_lancamentos do mês + fin_insumos do mês como tipo="insumo" -->
  </lancamentos>
  <por_pagamento>
    <forma nome="" qtd="" total_centavos=""/>
  </por_pagamento>
</relatorio_mensal>
```
  Escape XML correto em textos (& < > " '). Valores sempre em centavos inteiros.
- PDF: `GET /api/painel/relatorio/pdf?mes=YYYY-MM` gera o PDF do MÊS
  (título "Relatório mensal — <mês por extenso>/<ano>", tabela por dia +
  bloco financeiro com as duas camadas de lucro). `?data=` segue como hoje.
- Tela Relatório (public/painel.html + painel.js): alternância **Dia | Mês**.
  Modo Mês: `<input type="month">`, cards no padrão de cores atual
  (Faturamento verde, Concluídos roxo, Cancelados vermelho, Ticket azul,
  Insumos azul, Despesas vermelho, Investimento amarelo, Lucro conforme sinal),
  tabela de dias, e botões **📄 PDF do mês** e **🧾 XML p/ contabilidade**
  (link de download autenticado — seguir o mesmo padrão do botão PDF atual).
  Mostrar no modo Mês os dois lucros: "Lucro das vendas (operacional)" e
  "Resultado após investimentos".
- Tela Financeiro: exibir também a linha do **lucro operacional** junto do
  lucro real no cálculo do dia (usar os campos novos; sem quebrar o layout).

## Fora de escopo
Notificações/WhatsApp (já pronto), NF-e (o XML é relatório gerencial, não
documento fiscal — deixar isso claro num comentário no topo do XML gerado:
`<!-- Relatorio gerencial - nao e documento fiscal -->`), telas da loja.

## Aceite (evidência numérica obrigatória)
1. Regressão do dia: cenário clássico (insumos 20700, despesa 3000, receita
   manual 2000, vendas ENTREGUE 10500/4 copos, investimento 5000 lançado) →
   lucro_real −16200, **lucro_operacional −11200** (a diferença é o investimento).
2. Mensal: pedidos em 2 dias do mês-alvo + 1 dia no mês vizinho → o relatório
   do mês-alvo soma SÓ o mês-alvo; totais batem com a soma dos relatórios
   diários; por_pagamento confere.
3. XML: baixar, parsear com parser XML de verdade (ex.: python ElementTree) —
   tem que ser válido; atributos do <resumo> iguais aos do endpoint JSON;
   nº de <pedido> = pedidos do mês.
4. PDF mensal: HTTP 200 + content-type application/pdf.
5. node --check limpo; suíte antiga do financeiro/relatório diário segue verde.
