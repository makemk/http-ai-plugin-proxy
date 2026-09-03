<#
.SYNOPSIS
    Starts the HTTP AI Plugin Proxy local bridge.
#>

param(
    [string]$ConfigPath = "$PSScriptRoot\..\deployment.local.json",
    [int]$Port = 18889
)

if (-not (Test-Path $ConfigPath)) {
    $ConfigPath = [System.IO.Path]::Combine($env:USERPROFILE, ".browser-gateway", "deployment.local.json")
}

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host " Starting HTTP AI Plugin Proxy Bridge (127.0.0.1:$Port)" -ForegroundColor Green
Write-Host " Config: $(Split-Path $ConfigPath -Leaf)" -ForegroundColor Yellow
Write-Host "========================================================" -ForegroundColor Cyan

$env:HTTP_PROXY = "http://127.0.0.1:$Port"
$env:HTTPS_PROXY = "http://127.0.0.1:$Port"
$env:ALL_PROXY = "http://127.0.0.1:$Port"
$env:http_proxy = "http://127.0.0.1:$Port"
$env:https_proxy = "http://127.0.0.1:$Port"
$env:NO_PROXY = "127.0.0.1,localhost"
$env:no_proxy = "127.0.0.1,localhost"
$env:PROXY_PORT = $Port
$env:UV_THREADPOOL_SIZE = "20"

node "$PSScriptRoot\cli.js" "$ConfigPath"
