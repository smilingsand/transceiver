#requires -Version 5.1
<#[
Bridge Lab service controller (Windows PowerShell 5.1+).
Usage: .\scripts\bridge-lab.ps1 -Action status|start|stop
       .\scripts\bridge-lab.ps1 -Action start -ConfigPath 'D:\AI-Brain\BridgeLab\config.json'
Only processes started by this controller are eligible for stop.
#>
[CmdletBinding()]
param(
    [ValidateSet('start','stop','status')][string]$Action = 'status',
    [string]$ConfigPath = 'D:\AI-Brain\BridgeLab\config.json',
    [string]$StateDir = 'D:\AI-Brain\BridgeLab\state',
    [string]$ProfileDir = 'D:\AI-Brain\BridgeLab\tunnel-profiles',
    [string]$TunnelProfile = 'transceiver-t2',
    [string]$TunnelExe = 'D:\Program Files\tunnel-client\tunnel-client.exe',
    [string]$GitExe = 'D:\Program Files\Git\mingw64\bin\git.exe',
    [string]$CodexBin = '',
    [string]$ExpectedCodexVersion = '0.166.0-alpha.5.1',
    [string]$NodeExe = 'node.exe',
    [int]$Port = 8876
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pluginDir = Join-Path $repoRoot 'plugins\transceiver'
$runtime = Join-Path $pluginDir 'scripts\reverse-runtime.mjs'
$controlDir = Join-Path (Split-Path -Parent $ConfigPath) 'control'
$pidPath = Join-Path $controlDir 'processes.json'
$health = "http://127.0.0.1:$Port/healthz"
$logDir = Join-Path (Split-Path -Parent $ConfigPath) 'logs'
$verifiedCodexDir = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin\22cfb1d302613eae'

function Assert-File([string]$p,[string]$name) {
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "$name not found: $p" }
}
function Read-Record {
    if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json) }
    catch { throw "Invalid controller state file $pidPath : $_" }
}
function Find-Process([object]$entry, [string]$marker) {
    if ($null -eq $entry -or $null -eq $entry.pid) { return $null }
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$entry.pid)" -ErrorAction SilentlyContinue
    if (-not $p) { return $null }
    # Match executable process command line and original creation time to avoid PID reuse.
    if (-not $p.CommandLine -or -not $p.CommandLine.Contains($marker)) { return $null }
    $actual = ([datetime]$p.CreationDate).ToUniversalTime()
    $expected = [datetime]::Parse([string]$entry.startedUtc).ToUniversalTime()
    if ([math]::Abs(($actual - $expected).TotalSeconds) -gt 5) { return $null }
    return $p
}
function Resolve-TunnelCredential([string]$name) {
    # Prefer a current-process override, otherwise use the persistent Windows user setting.
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ([string]::IsNullOrWhiteSpace($value)) {
        $value = [Environment]::GetEnvironmentVariable($name, 'User')
    }
    return $value
}
function Test-Health {
    try {
        $res = Invoke-RestMethod -Uri $health -TimeoutSec 2
        return ($res.ok -eq $true)
    } catch { return $false }
}
function Resolve-Executable([string]$value) {
    if (Test-Path -LiteralPath $value -PathType Leaf) { return (Resolve-Path -LiteralPath $value).Path }
    $c = Get-Command $value -ErrorAction SilentlyContinue
    if ($c -and $c.Source) { return $c.Source }
    throw "Executable not found: $value"
}
function Resolve-CodexBin {
    $selected = $verifiedCodexDir
    if (-not [string]::IsNullOrWhiteSpace($CodexBin)) { $selected = $CodexBin }
    $exe = Join-Path $selected 'codex.exe'
    Assert-File $exe 'Pinned Codex CLI'
    $actual = ((& $exe --version 2>&1 | Out-String).Trim())
    if ($LASTEXITCODE -ne 0) { throw "Pinned Codex CLI cannot run: $exe" }
    $expected = "codex-cli $ExpectedCodexVersion"
    if ($actual -ne $expected) {
        throw "Codex CLI version mismatch: expected '$expected', actual '$actual'; path: $exe. Update the verified path/version after testing; no PATH fallback."
    }
    return $selected
}
function New-LogPaths([string]$prefix) {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss-fff')
    return @{ Out = (Join-Path $logDir "$prefix-$stamp-out.log"); Err = (Join-Path $logDir "$prefix-$stamp-err.log") }
}
function New-Entry([System.Diagnostics.Process]$proc) {
    # CreationTime comes from Windows process metadata, not the wall clock before Start-Process.
    $proc.Refresh()
    return @{ pid = [int]$proc.Id; startedUtc = $proc.StartTime.ToUniversalTime().ToString('o') }
}
function Write-Record([object]$record) {
    New-Item -ItemType Directory -Force -Path $controlDir | Out-Null
    $tmp = "$pidPath.tmp.$PID"
    $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $pidPath -Force
}
function Show-Status {
    $record = Read-Record
    $bridgeManaged = $null
    $tunnelManaged = $null
    if ($record) {
        $bridgeManaged = Find-Process $record.bridge 'reverse-runtime.mjs'
        $tunnelManaged = Find-Process $record.tunnel 'tunnel-client.exe'
    }
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    Write-Host "Bridge managed: $([bool]$bridgeManaged); health: $(Test-Health); port ${Port} listener PID: $(if ($listener) {$listener.OwningProcess} else {'none'})"
    Write-Host "Tunnel managed: $([bool]$tunnelManaged)"
    if ($listener -and -not $bridgeManaged) { Write-Warning 'A listener exists but is not owned by this controller. It will not be stopped.' }
    if (-not $record -and -not $listener) { Write-Host 'Controller state: stopped (no PID record, no Bridge listener).' }
    elseif (-not $record) { Write-Host 'Controller state: unmanaged processes, not eligible for stop.' }
    if ($record -and $record.logs) {
        Write-Host "Logs:"
        Write-Host "  Bridge stdout : $($record.logs.bridgeOut)"
        Write-Host "  Bridge stderr : $($record.logs.bridgeErr)"
        Write-Host "  Tunnel stdout : $($record.logs.tunnelOut)"
        Write-Host "  Tunnel stderr : $($record.logs.tunnelErr)"
     }
}

switch ($Action) {
    'status' { Show-Status; break }
    'start' {
        Assert-File $ConfigPath 'Bridge config'
        Assert-File $TunnelExe 'Tunnel client'
        Assert-File $GitExe 'Git executable'
        Assert-File $runtime 'Reverse runtime entry'
        if (-not (Test-Path -LiteralPath $ProfileDir -PathType Container)) { throw "Profile directory not found: $ProfileDir" }
        if (-not (Test-Path -LiteralPath $StateDir -PathType Container)) { throw "State directory not found: $StateDir" }
        $record = Read-Record
        if ($record) {
            if ((Find-Process $record.bridge 'reverse-runtime.mjs') -or (Find-Process $record.tunnel 'tunnel-client.exe')) {
                throw 'Existing controller-managed process detected. Run status/stop first.'
            }
            throw "Stale PID record exists: $pidPath. Inspect and remove it manually after confirming processes are gone."
        }
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($listener) { throw "Port $Port already has a listener. Refusing to start a second Bridge." }
        $existingTunnel = Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue
        if ($existingTunnel) { throw 'tunnel-client.exe is already running. Refusing duplicate tunnel. Use status and inspect manually.' }
        $node = Resolve-Executable $NodeExe
        $prior = @{}
        foreach ($k in @('TRANSCEIVER_CONFIG','TRANSCEIVER_STATE_DIR','TRANSCEIVER_GIT_EXECUTABLE','CONTROL_PLANE_API_KEY','CONTROL_PLANE_TUNNEL_ID','PATH')) {
            $prior[$k] = [Environment]::GetEnvironmentVariable($k,'Process')
        }
        $bridge = $null
        $tunnel = $null
        try {
            $env:TRANSCEIVER_CONFIG = $ConfigPath
            $env:TRANSCEIVER_STATE_DIR = $StateDir
            $env:TRANSCEIVER_GIT_EXECUTABLE = $GitExe
            $selectedCodexBin = Resolve-CodexBin
            # Prepend only the validated pinned CLI directory for the child Bridge.
            # This is independent of user PATH, and prior PATH is restored in finally.
            $env:PATH = "$selectedCodexBin;$env:PATH"
            $bridgeLogs = New-LogPaths 'bridge'
            $bridge = Start-Process -FilePath $node -ArgumentList @($runtime) -WorkingDirectory $pluginDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $bridgeLogs.Out -RedirectStandardError $bridgeLogs.Err
            $bridgeInfo = New-Entry $bridge
            $ready = $false
            foreach ($i in 1..20) {
                Start-Sleep -Milliseconds 500
                if (Test-Health) { $ready = $true; break }
                $bridge.Refresh()
                if ($bridge.HasExited) { break }
            }
            if (-not $ready) { throw "Bridge did not become healthy. Review: $($bridgeLogs.Out) and $($bridgeLogs.Err)" }
            # Map the user's existing Windows user variables into the tunnel-client's
            # expected process-local names. Never write secrets to a file or log.
            $tunnelKey = Resolve-TunnelCredential 'OpenAI_Tunnel_API_KEY'
            $tunnelId = Resolve-TunnelCredential 'Tunnel_ID'
            if ([string]::IsNullOrWhiteSpace($tunnelKey) -or [string]::IsNullOrWhiteSpace($tunnelId)) {
                throw 'Missing user credentials: OpenAI_Tunnel_API_KEY and/or Tunnel_ID. Configure them in Windows user environment variables.'
            }
            if (-not $tunnelId.StartsWith('tunnel_')) {
                throw 'Tunnel_ID must contain the full ID, including its tunnel_ prefix.'
            }
            $env:CONTROL_PLANE_API_KEY = $tunnelKey
            $env:CONTROL_PLANE_TUNNEL_ID = $tunnelId
            $tunnelLogs = New-LogPaths 'tunnel'
            $tunnel = Start-Process -FilePath $TunnelExe -ArgumentList @('run','--profile',$TunnelProfile,'--profile-dir',('"' + $ProfileDir + '"')) -WorkingDirectory (Split-Path -Parent $TunnelExe) -PassThru -WindowStyle Hidden -RedirectStandardOutput $tunnelLogs.Out -RedirectStandardError $tunnelLogs.Err
            $tunnelInfo = New-Entry $tunnel
            Start-Sleep -Seconds 2
            $tunnel.Refresh()
            if ($tunnel.HasExited) { throw "Tunnel Client exited at startup. Review: $($tunnelLogs.Out) and $($tunnelLogs.Err)" }
            # Secrets should only be inherited by tunnel-client, not retained in the shell.
            Remove-Variable tunnelKey -ErrorAction SilentlyContinue
            Write-Record @{ version = 2; bridge = $bridgeInfo; tunnel = $tunnelInfo; configPath = $ConfigPath; codexExe = (Join-Path $selectedCodexBin 'codex.exe'); logs = @{ bridgeOut=$bridgeLogs.Out; bridgeErr=$bridgeLogs.Err; tunnelOut=$tunnelLogs.Out; tunnelErr=$tunnelLogs.Err } }
            Write-Host "Started Bridge PID $($bridge.Id) and Tunnel PID $($tunnel.Id)."
            Show-Status
        }
        catch {
            if ($tunnel -and -not $tunnel.HasExited -and -not (Test-Path -LiteralPath $pidPath)) {
                Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
            }
            if ($bridge -and -not $bridge.HasExited -and -not (Test-Path -LiteralPath $pidPath)) {
                # If tunnel launch failed, stop only the Bridge started in this invocation.
                Stop-Process -Id $bridge.Id -ErrorAction SilentlyContinue
            }
            throw
        }
        finally {
            foreach ($k in $prior.Keys) { [Environment]::SetEnvironmentVariable($k,$prior[$k],'Process') }
        }
        break
    }
    'stop' {
        $record = Read-Record
        if (-not $record) { Write-Warning 'No managed processes recorded. Nothing to stop.'; break }
        $tunnel = Find-Process $record.tunnel 'tunnel-client.exe'
        $bridge = Find-Process $record.bridge 'reverse-runtime.mjs'
        if ($tunnel) { Stop-Process -Id ([int]$record.tunnel.pid) -ErrorAction Stop; Write-Host 'Stopped managed tunnel.' }
        if ($bridge) { Stop-Process -Id ([int]$record.bridge.pid) -ErrorAction Stop; Write-Host 'Stopped managed Bridge.' }
        if (-not $tunnel -and -not $bridge) { Write-Warning 'Managed PIDs no longer match running processes; no process was terminated.' }
        Remove-Item -LiteralPath $pidPath -Force
        Show-Status
        break
    }
}
