@echo off
rem HTMLスライドエディター起動用（ダブルクリックで実行）
cd /d "%~dp0"
title HTMLスライドエディター
set URL=http://localhost:5180/editor/

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。https://nodejs.org/ からインストールしてください。
  pause
  exit /b 1
)

rem すでに起動中ならブラウザだけ開く
netstat -ano | findstr ":5180" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo エディターは既に起動しています。ブラウザで開きます。
  start "" "%URL%"
  timeout /t 3 >nul
  exit /b 0
)

echo エディターを起動しています…
echo このウィンドウを閉じるとエディターは終了します。
echo.
rem サーバー起動を少し待ってからブラウザを開く
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 1; Start-Process '%URL%'"
node server.js
echo.
echo サーバーが停止しました。
pause