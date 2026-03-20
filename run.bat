@echo off
cd /d "%~dp0"
powershell -NoExit -ExecutionPolicy Bypass -Command "& '.\.tools\node-v22.14.0-win-x64\node.exe' server.js"
