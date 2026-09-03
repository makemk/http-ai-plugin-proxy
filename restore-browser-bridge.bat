@echo off
echo [恢复] 正在恢复浏览器借道桥模式 (18888 端口)...
powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('CLOUD_CODE_URL', 'http://127.0.0.1:18888/bridge', 'User')"
echo [完成] 已恢复 CLOUD_CODE_URL 为 18888。重启 VS Code 即可恢复浏览器借道模式。
pause

