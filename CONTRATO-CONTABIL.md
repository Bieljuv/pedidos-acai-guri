# CONTRATO — v1.7.1: menu "Contábil" (pedido direto do Gabriel)

Reclamação dele: o relatório mensal ficou escondido numa alternância dentro
de Relatório do Dia e ele não encontrou. Decisão dele: **menu próprio
chamado "Contábil"**.

## O que fazer

1. **Sidebar ganha o item "🧾 Contábil"** (logo após "Relatório do Dia",
   seguindo o mesmo padrão visual/ativo dos demais itens).
2. **Nova tela Contábil** (`view-contabil`), reunindo o que hoje está no
   modo Mês do Relatório:
   - `<input type="month">` (mês atual por padrão)
   - cards do mês (mesmas cores atuais: Faturamento verde, Concluídos roxo,
     Cancelados vermelho, Ticket azul, Insumos azul, Despesas vermelho,
     Investimento amarelo, Lucro das vendas/operacional conforme sinal)
   - banner/linha "Resultado após investimentos"
   - tabela dia a dia do mês
   - botões **📄 PDF do mês** e **🧾 XML p/ contabilidade**
   - Reusar 100% os endpoints atuais (`/api/painel/relatorio/mensal`,
     `/relatorio/mensal/xml`, `/relatorio/pdf?mes=`) — **backend NÃO muda**.
3. **Relatório do Dia volta a ser só do dia**: remover a alternância
   Dia|Mês e o bloco do modo Mês de lá (o código mensal migra pra tela
   Contábil — mover, não duplicar). O relatório diário (data, PDF do dia,
   tops, formas de pagamento) fica exatamente como era antes da v1.7.
4. A tela Financeiro não muda nesta versão.

## Aceite
- Navegação: clicar em "Contábil" abre a tela com os dados do mês atual
  sem erro de console; clicar em "Relatório do Dia" mostra só o diário
  (sem chips Dia/Mês em nenhum lugar do painel — grep limpo de `data-modo`
  e `relMes` fora da tela Contábil).
- XML e PDF do mês baixam a partir da tela Contábil (mesmos testes da v1.7).
- node --check limpo; endpoints backend intactos (diff de server.js e
  src/ vazio ou justificável).
