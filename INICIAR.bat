@echo off
chcp 65001 >nul
title Sistema de Pedidos - Acai do Guri
cd /d %~dp0
echo ============================================
echo   Sistema de Pedidos - Acai do Guri
echo   Loja:   http://localhost:3333
echo   Painel: http://localhost:3333/painel
echo   Para desligar: feche esta janela
echo ============================================
node server.js
pause
