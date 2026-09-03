@echo off
echo [修复] 正在解除浏览器借道劫持，切换为 18889 独立极速代理...
powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('CLOUD_CODE_URL', $null, 'User')"
echo [完成] 已清除 CLOUD_CODE_URL 劫持变量！
echo 请重启 VS Code，即可彻底摆脱对 Chrome 和 Browser Gateway 的依赖！
pause

