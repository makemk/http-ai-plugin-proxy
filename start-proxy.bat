@echo off
title HTTP AI Plugin Proxy Gateway
echo ========================================================
echo  Starting HTTP AI Plugin Proxy Bridge (127.0.0.1:18889)
echo ========================================================

set HTTP_PROXY=http://127.0.0.1:18889
set HTTPS_PROXY=http://127.0.0.1:18889
set ALL_PROXY=http://127.0.0.1:18889
set http_proxy=http://127.0.0.1:18889
set https_proxy=http://127.0.0.1:18889
set NO_PROXY=127.0.0.1,localhost
set no_proxy=127.0.0.1,localhost
set UV_THREADPOOL_SIZE=20

cd /d "%~dp0"
node cli.js %1
pause
