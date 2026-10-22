# CONTRATO — v1.8: login de funcionários + ponto eletrônico

Desenho APROVADO pelo Gabriel (22/10): funcionários com login próprio e
acessos cortados + bater ponto com janela de horário, alerta sonoro de fim
de expediente e relatório pro admin. A tabela `usuarios` já tem nome,
login (único), senha_hash (scrypt), perfil e ativo — construir sobre ela.

## A. Perfis e permissões (servidor manda, não só a tela)
- Perfis: `admin` (tudo) e `funcionario`.
- Middleware de autorização por rota (além do auth atual): rotas de
  Financeiro, Contábil/Relatórios, Meios de Recebimento, Configurações,
  Bairros/Taxas (escrita), Equipe/Ponto (gestão) e pagamentos/config =
  **só admin** → funcionário recebe **403** JSON.
- Funcionário PODE: pedidos (listar, detalhar, mudar status, imprimir
  comanda), cardápio **somente pausar/ativar** produto e opção (PUT de
  preço/criar/excluir = 403), abrir/pausar a loja (endpoint de estado da
  loja liberado), o próprio ponto, trocar a própria senha.
- Painel (front): esconde os menus proibidos por perfil (admin vê tudo);
  o nome/perfil de quem está logado aparece no topo; se uma rota devolver
  403, mostrar aviso amigável e voltar pros Pedidos.
- Registro de autoria: `pedidos` ganha `atualizado_por` (nome) — preenchido
  a cada transição de status com o nome do usuário da sessão; exibido no
  detalhe/histórico do pedido no painel ("confirmado por Maria").

## B. Gestão da equipe (tela nova, só admin): menu "👥 Equipe"
- CRUD de funcionários: nome, login, senha inicial (hash scrypt),
  perfil fixo `funcionario`, ativo/inativo (inativo = login recusado),
  redefinir senha, excluir (soft: ativo=0 é o caminho padrão; excluir
  físico só se nunca bateu ponto — senão 422 explicando).
- Jornada por funcionário: `hora_entrada`, `hora_saida` ('HH:MM'),
  `dias_semana` (ex.: '1,2,3,4,5,6,0'), tolerâncias
  `janela_antes_min` (padrão 30) e `janela_depois_min` (padrão 30).
  Colunas novas em `usuarios` (ALTER idempotente nos dois bancos) ou
  tabela `jornadas` 1:1 — escolher o mais simples e documentar.

## C. Janela de acesso (login do funcionário)
- No login: se perfil=funcionario, conferir em America/Sao_Paulo:
  hoje é dia de trabalho? agora está entre (entrada − janela_antes) e
  (saida + janela_depois)? Fora disso → **403** com mensagem
  "Fora do seu horário de trabalho. Seu turno: HH:MM–HH:MM."
- **Admin NUNCA é bloqueado.** Turno que cruza a meia-noite: fora de
  escopo (loja fecha 22h) — se saida <= entrada, tratar como inválido no
  cadastro (422).
- Sessão do funcionário que fica aberta além do fim da janela: não derrubar
  no meio do trabalho; o bloqueio é no LOGIN (e o ponto de saída encerra a
  sessão — ver D).

## D. Ponto eletrônico
- Tabela `pontos`: id, loja_id, usuario_id, tipo ('entrada'|'saida'),
  registrado_em (UTC, default now), origem ('painel'|'admin'),
  observacao. Índices por usuario/data.
- Endpoints (usuário logado): `GET /api/painel/ponto/hoje` → { entrada,
  saida, estado }; `POST /api/painel/ponto/entrada`; `POST
  /api/painel/ponto/saida` (grava e **invalida a sessão** — o front desloga
  e mostra "Ponto de saída registrado às HH:MM").
  Regras: entrada duplicada no dia → 422; saída sem entrada → 422.
- Tela do funcionário: ao logar, a área inicial (topo da tela de Pedidos
  ou cartão próprio visível) mostra o cartão **Ponto**: estado atual,
  botão grande **Bater ponto de entrada** / **Bater ponto de saída**.
- **Alerta de fim de expediente**: com entrada aberta, faltando **5 min
  pra hora_saida** da jornada, o painel toca **som alto em loop** (usar o
  som mais alto já existente em public/sons/ ou um alarme dedicado) +
  banner fixo "Faltam 5 minutos pra encerrar seu expediente — não esqueça
  de bater o ponto de saída". Para ao bater a saída ou ao clicar em
  "Entendi" (silencia por essa vez). Checagem por timer no front (30s)
  usando a jornada retornada por /ponto/hoje. Admin NÃO recebe esse alerta.
- Admin na tela Equipe → aba/seção **Ponto do mês**: por funcionário,
  tabela de dias (entrada, saída, horas no dia), dias "em aberto"
  destacados, **total de horas no mês**; admin pode **lançar ajuste**
  (entrada/saída manual com observação, origem='admin') e fechar um dia
  em aberto. Mês navegável (?mes=YYYY-MM).

## E. Compatibilidade
- Bancos: SQLite e Postgres (migrations idempotentes nos dois; schema.sql
  atualizado; reset-e-recomecar.sql inclui `pontos` no TRUNCATE).
- O fluxo do Telegram (botões do dono) segue funcionando — transições por
  lá gravam atualizado_por='Telegram'.
- Seed/demo: criar usuário demo `maria` (funcionária, senha maria123,
  jornada 14:00–22:00 seg–sáb) SOMENTE no seed local de demonstração?
  NÃO — não criar contas extras no seed de produção do primo. Em vez
  disso, os testes usam a API de gestão pra criar a funcionária.

## Aceite (evidência obrigatória)
1. Admin cria funcionária (jornada 14:00–22:00) → ela loga dentro da
   janela (simular horário via jornada configurada pros minutos atuais do
   teste) e FORA da janela o login é recusado com a mensagem do turno.
2. Funcionária: GET financeiro → 403; menu some no front; pausar um
   produto → 200; tentar mudar preço → 403; pedidos/status → 200 e o
   pedido registra atualizado_por com o nome dela.
3. Ponto: entrada 201; entrada duplicada 422; /ponto/hoje reflete;
   saída 201 e a sessão morre (próxima chamada com o token → 401).
4. Alerta: com jornada terminando em ≤5 min, o front dispara o banner
   (teste Playwright: banner visível e o elemento de áudio tocando —
   ou evidência equivalente do estado do alerta).
5. Admin: relatório do mês soma as horas certas num cenário de 2 dias
   (ex.: 14:02→22:00 = 7h58) e o dia em aberto aparece destacado; ajuste
   manual do admin fecha o dia.
6. Regressão: login admin normal, fluxo de pedidos e relatórios das
   versões anteriores intactos; node --check limpo; suíte nos DOIS bancos
   se viável (mínimo SQLite completo + schema PG revisado).
