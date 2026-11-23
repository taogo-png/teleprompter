@echo off
chcp 65001 >nul
title Teleprompter
cd /d "%~dp0"
echo.
echo  ===== TELEPROMPTER =====
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  O Node.js nao foi encontrado. Instale em https://nodejs.org e abra este arquivo de novo.
  pause
  exit /b
)
echo  Painel ligado. Abra o app Teleprompter no iPhone, no mesmo Wi-Fi.
echo  Para desligar, feche esta janela.
echo.
node pc\server.js --open
pause
