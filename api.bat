@echo off
cd /d "%~dp0"
title IDEA StatiCa REST API

REM --- IDEA StatiCa Connection REST API (".ideaCon" butonu icin, localhost:5000) ---
REM Kurulu en yeni StatiCa surumundeki exe'yi bul.
set "IDEA_REST="
for /d %%D in ("%ProgramFiles%\IDEA StatiCa\StatiCa *") do (
  if exist "%%~D\IdeaStatiCa.ConnectionRestApi.exe" set "IDEA_REST=%%~D\IdeaStatiCa.ConnectionRestApi.exe"
)

if not defined IDEA_REST (
  echo [HATA] IDEA StatiCa Connection REST API bulunamadi.
  echo         IDEA StatiCa kurulu degil ya da farkli bir konumda:
  echo         "%ProgramFiles%\IDEA StatiCa\StatiCa *\IdeaStatiCa.ConnectionRestApi.exe"
  echo.
  pause
  exit /b 1
)

REM Zaten calisiyorsa ikinci kez baslatma (port 5000 cakismasin).
tasklist /FI "IMAGENAME eq IdeaStatiCa.ConnectionRestApi.exe" 2>nul | find /I "IdeaStatiCa.ConnectionRestApi.exe" >nul
if not errorlevel 1 (
  echo [IDEA] REST servisi zaten calisiyor ^(localhost:5000^). Bu pencereyi kapatabilirsin.
  echo.
  pause
  exit /b 0
)

echo [IDEA] REST API baslatiliyor ^(localhost:5000^) - bu pencereyi ACIK birak:
echo        "%IDEA_REST%"
echo.
"%IDEA_REST%"

echo.
echo [IDEA] REST API kapandi.
pause
