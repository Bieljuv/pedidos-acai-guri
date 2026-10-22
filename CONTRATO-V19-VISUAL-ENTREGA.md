# CONTRATO — v1.9: visual completo + ícones + código de entrega + módulo 99

Base: commit da v1.8 (esta versão só começa com a v1.8 commitada — os
arquivos são os mesmos). Pedidos do Gabriel em 22/10 ~06:15.

## A. Visual e ícones (loja, acompanhamento e painel)
1. **Zero emoji em toda a interface** (HTML/CSS/JS do front, login,
   acompanhamento e comanda impressa). Substituir por **ícones SVG inline**
   (traço consistente, currentColor, um helper/sprite único por app):
   cada menu, card, botão e cabeçalho com ícone que combina com a função:
   Pedidos=recibo/lista · Cardápio=livro/talheres · Grupos e Opções=camadas ·
   **Bairros e Taxas=MOTO** (SVG de motocicleta — pedido expresso dele) ·
   Meios de Recebimento=cartão/nota · Loja e Aparência=loja ·
   Relatório do Dia=gráfico · Contábil=calculadora · Financeiro=carteira ·
   Equipe=pessoas · Ponto=relógio · Configurações=engrenagem · Sair=porta ·
   Pausar=pause · sons=sino. Mensagens de WhatsApp/Telegram também sem
   emoji (texto limpo; botões do Telegram com texto puro).
2. **Botão de tema em modelo novo**: sai a pílula "Claro | Escuro" com
   texto; entra **controle segmentado com ícones sol/lua** e indicador
   deslizante (transição suave), mantendo a persistência atual
   (localStorage) e valendo no painel e no login.
3. **Polimento visual geral** (sem mudar a estrutura das telas):
   raios/sombras consistentes nos cards, cabeçalhos de card com
   ícone + título, estados vazios com ícone, hovers/foco uniformes,
   botões primários consistentes entre loja e painel, login repaginado.
   Paleta continua a da logo (roxo) — não trocar as cores da marca.

## B. Revisão das configurações de WhatsApp e Telegram
Auditar de ponta a ponta e CORRIGIR o que estiver faltando/falho:
- Evolution: URL base, instância e token validados; **teste real** envia
  mensagem de verdade pro número que o admin digitar (não só "ping").
- Telegram: token validado (getMe), detectar chat funcionando, **teste
  real** envia mensagem pro chat detectado.
- Os selos do topo (WhatsApp/Telegram: configurado × simulado) têm que
  refletir o estado REAL salvo.
- Guias "Como configurar" conferidos passo a passo (texto bate com as
  telas atuais); segredos sempre mascarados; feedback claro ao salvar.
- Relatar no fechamento: o que estava errado/faltando e o que mudou.

## C. Código de entrega em TODO pedido
- `pedidos.codigo_entrega`: 4 dígitos ('0000'–'9999'), gerado na criação
  (SQLite + PG), único entre pedidos não finalizados (regenera em colisão).
- Aparece: **acompanhamento do cliente** em destaque ("informe ao
  entregador"), mensagens ao cliente (saiu pra entrega), **comanda**,
  cartão e detalhe do pedido no painel, mensagem do dono no Telegram.
- **Baixa da entrega**: no painel, marcar ENTREGUE (entrega OU retirada)
  abre diálogo pedindo o código; código errado → erro e NÃO muda o status;
  certo → ENTREGUE. **Admin** tem "entregar sem código" (fica registrado
  no histórico do pedido); funcionário NÃO tem essa saída.
- Telegram: o botão Entregue responde pedindo o código ("digite o código
  do pedido #N"); a próxima mensagem de 4 dígitos do dono confirma
  (estado pendente por chat). Comando de texto equivalente aceito.

## D. Módulo Entregador 99 (preparado pra token)
- Configurações (só admin) ganha **"Entregador 99"**: campo **token da
  API** (mascarado), liga/desliga, status ("aguardando token" ×
  "configurado") e guia "Como obter o token" (99 Empresas → Solicitar
  token API / api-suporte@99app.com; retorno em até 2 dias úteis;
  integração voltada a empresas — critério de volume pode se aplicar).
- Pedido de entrega (EM_PREPARO/PRONTO) ganha botão **"Chamar entregador
  99"**:
  - **Sem token** → abre o **despacho manual**: coleta (endereço da loja),
    destino (cliente/endereço/telefone) e o **PIN = código de entrega**,
    tudo pronto pra copiar pro app da 99; registra no pedido
    (provedor=99, modo=manual, horário da chamada).
  - **Com token** → chama a API oficial via adaptador único
    (`src/entrega99.js`, base URL e campos centralizados e comentados —
    a especificação oficial é entregue pela 99 ao parceiro junto do
    token): envia coleta, destino, contato e o **PIN (codigo_entrega)**;
    grava o id externo e o status da entrega no pedido; erro da API
    aparece claro, sem marcar nada como despachado.
- Pedidos ganham: entrega_provedor, entrega_ext_id, entrega_status,
  entrega_chamada_em (migrations nos dois bancos + schema.sql).

## Aceite (evidência obrigatória)
1. Prints (Playwright, claro E escuro): loja, painel (Pedidos), login —
   zero emoji visível; grep de emoji nos arquivos públicos ≈ 0 (listar
   qualquer exceção justificada); menu Bairros e Taxas com a moto.
2. Botão de tema novo funcionando (alterna e persiste após reload).
3. Config: testes reais de WhatsApp/Telegram exercitados em modo
   simulado/sem credencial com mensagens de estado corretas (sem 500);
   relatório da auditoria com achados e correções.
4. Código: pedido nasce com código; painel recusa ENTREGUE com código
   errado (status não muda) e aceita com o certo; override só admin e
   registrado; Telegram pede o código e confirma com os 4 dígitos.
5. 99: config salva o token mascarado; sem token, o botão abre o
   despacho manual com o PIN; com token fake, a chamada falha de forma
   limpa e explicada (nada marcado como despachado).
6. Regressão v1.8/v1.7 (ponto, perfis, relatórios) verde; node --check
   limpo; migrations idempotentes nos dois bancos.
