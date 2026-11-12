#requires -Version 5.1
<#[
Bridge Lab service controller (Windows PowerShell 5.1+).
Usage: .\scripts\bridge-lab.ps1 -Action status|start|stop|cleanup-logs
       .\scripts\bridge-lab.ps1 -Action start -ConfigPath 'config.json'
Only processes started by this controller are eligible for stop.
#>
[CmdletBinding()]
param(
    [ValidateSet('start','stop','status','cleanup-logs','help','/?','--Action')][string]$Action = 'status',
    [Alias('h')][switch]$Help,
    [switch]$DryRun,
    [switch]$Force,
    [switch]$All,
    # PowerShell binds the literal --Action as Action and its next word here.
    # Convert and validate immediately below, before reading config or doing work.
    [object]$LogRetentionDays = 7,
    [string]$ConfigPath = 'config.json',
    [string]$RuntimeDir = 'runtime',
    [string]$StateDir = '',
    [string]$ControlDir = '',
    [string]$LogDir = '',
    [string]$ProfileDir = '',
    [string]$TunnelProfile = 'transceiver-t2',
    [string]$TunnelExe = '',
    [string]$GitExe = '',
    [string]$CodexBin = '',
    [string]$ExpectedCodexVersion = '',
    [string]$NodeExe = 'node.exe',
    [ValidateRange(1,65535)][int]$Port = 8876,
    [ValidateRange(1,3600)][int]$BridgeStartupTimeoutSeconds = 30,
    [string]$DefaultSandbox = 'read-only',
    [string]$DefaultAccessStrategy = 'read-only',
    [ValidateSet('0','1')][string]$AllowWrite = '0',
    [ValidateSet('0','1')][string]$AllowDangerFullAccess = '0'
)
if ($Action -eq '--Action') {
    if ($PSBoundParameters.ContainsKey('LogRetentionDays') -and $LogRetentionDays -is [string] -and $LogRetentionDays -eq 'help' -and $PSBoundParameters.Count -eq 2) {
        $Action = 'help'
    } else { throw 'Only --Action help is supported; use -Action for other actions.' }
} elseif ($PSBoundParameters.ContainsKey('LogRetentionDays')) {
    try { $LogRetentionDays = [int]$LogRetentionDays } catch { throw 'LogRetentionDays must be an integer from 1 to 3650' }
    if ($LogRetentionDays -lt 1 -or $LogRetentionDays -gt 3650) { throw 'LogRetentionDays must be an integer from 1 to 3650' }
}
if ($Help -or $Action -in @('help','/?')) {
    Write-Output 'Usage: .\scripts\bridge-lab.ps1 help | -H | /?'
    Write-Output '       .\scripts\bridge-lab.ps1 start | status | stop'
    Write-Output '       .\scripts\bridge-lab.ps1 cleanup-logs [-DryRun] [-Force] [-All]'
    Write-Output 'cleanup-logs: confirm with y to delete; -Force bypasses confirmation; -DryRun previews; -All selects all eligible logs.'
    return
}
if (-not $PSBoundParameters.ContainsKey('TunnelExe')) { $TunnelExe = Join-Path $env:ProgramFiles 'tunnel-client\tunnel-client.exe' }
if (-not $PSBoundParameters.ContainsKey('GitExe')) { $GitExe = Join-Path $env:ProgramFiles 'Git\mingw64\bin\git.exe' }
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Force -and $Action -ne 'cleanup-logs') { throw '-Force is only valid with -Action cleanup-logs' }
if ($All -and $Action -ne 'cleanup-logs') { throw '-All is only valid with -Action cleanup-logs' }
if ($All -and $PSBoundParameters.ContainsKey('LogRetentionDays')) { throw '-All cannot be combined with -LogRetentionDays' }
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
# Only allow non-secret, documented settings. Values are data, never PowerShell code.
$envParameters = @{
    TUNNEL_PROFILE = 'TunnelProfile'; TUNNEL_EXE = 'TunnelExe'; GIT_EXE = 'GitExe'
    CODEX_BIN = 'CodexBin'; CODEX_VERSION = 'ExpectedCodexVersion'; NODE_EXE = 'NodeExe'; PORT = 'Port'
    BRIDGE_STARTUP_TIMEOUT_SECONDS = 'BridgeStartupTimeoutSeconds'
    LOG_RETENTION_DAYS = 'LogRetentionDays'
    CODEX_MCP_BRIDGE_DEFAULT_SANDBOX = 'DefaultSandbox'
    CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY = 'DefaultAccessStrategy'
    CODEX_MCP_BRIDGE_ALLOW_WRITE = 'AllowWrite'
    CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS = 'AllowDangerFullAccess'
}
function Read-BridgeEnv([string]$path) {
    $values = @{}
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $values }
    # Throw on invalid UTF-8; ReadAllLines supports UTF-8 with or without BOM.
    $lines = [IO.File]::ReadAllLines($path, (New-Object Text.UTF8Encoding($false, $true)))
    $lineNumber = 0
    foreach ($line in $lines) {
        $lineNumber++
        $text = $line.Trim()
        if (-not $text -or $text.StartsWith('#')) { continue }
        if ($text -notmatch '^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') { throw "Invalid bridge.env syntax at line $lineNumber" }
        $key = $Matches[1]
        $value = $Matches[2]
        if (-not $envParameters.ContainsKey($key)) { throw "Unsupported bridge.env key at line $lineNumber (only documented non-secret keys are allowed)" }
        if ($values.ContainsKey($key)) { throw "Duplicate bridge.env key at line $lineNumber" }
        if ($value.StartsWith('"') -or $value.StartsWith("'")) {
            $quote = [regex]::Escape($value.Substring(0,1))
            if ($value -notmatch "^$quote(.*?)$quote\s*(?:#.*)?$") { throw "Invalid quoted bridge.env value at line $lineNumber" }
            $value = $Matches[1]
        } else {
            $value = ($value -replace '\s+#.*$', '').Trim()
        }
        # No expansion of variables, backticks, backslashes or subexpressions.
        $values[$key] = $value
    }
    return $values
}
$envValues = Read-BridgeEnv (Join-Path $repoRoot 'bridge.env')
foreach ($key in $envValues.Keys) {
    $parameter = $envParameters[$key]
    if (-not $PSBoundParameters.ContainsKey($parameter)) {
        $value = $envValues[$key]
        if ($parameter -eq 'Port' -and ($value -notmatch '^\d+$' -or [long]$value -lt 1 -or [long]$value -gt 65535)) {
            throw 'bridge.env PORT must be an integer from 1 to 65535'
        }
        if ($parameter -in @('AllowWrite','AllowDangerFullAccess') -and $value -notin @('0','1')) {
            throw "bridge.env $key must be 0 or 1"
        }
        if ($parameter -eq 'BridgeStartupTimeoutSeconds' -and ($value -notmatch '^\d{1,4}$' -or [int]$value -lt 1 -or [int]$value -gt 3600)) {
            throw 'bridge.env BRIDGE_STARTUP_TIMEOUT_SECONDS must be an integer from 1 to 3600'
        }
        if ($parameter -eq 'LogRetentionDays' -and ($value -notmatch '^\d{1,4}$' -or [int]$value -lt 1 -or [int]$value -gt 3650)) {
            throw 'bridge.env LOG_RETENTION_DAYS must be an integer from 1 to 3650'
        }
        if ($parameter -eq 'LogRetentionDays') { $value = [int]$value }
        Set-Variable -Name $parameter -Value $value
    }
}
function Resolve-RepoPath([string]$value) {
    if (-not [IO.Path]::IsPathRooted($value)) { $value = Join-Path $repoRoot $value }
    return [IO.Path]::GetFullPath($value)
}
$ConfigPath = Resolve-RepoPath $ConfigPath
$RuntimeDir = Resolve-RepoPath $RuntimeDir
foreach ($setting in @{ StateDir='state'; ProfileDir='tunnel-profiles'; ControlDir='control'; LogDir='logs' }.GetEnumerator()) {
    $value = Get-Variable -Name $setting.Key -ValueOnly
    if ([string]::IsNullOrWhiteSpace($value)) { $value = Join-Path $RuntimeDir $setting.Value }
    Set-Variable -Name $setting.Key -Value (Resolve-RepoPath $value)
}
foreach ($name in @('TunnelExe','GitExe','CodexBin','NodeExe')) {
    $value = Get-Variable -Name $name -ValueOnly
    if ($value -and ($name -ne 'NodeExe' -or $value -match '[/\\]')) {
        Set-Variable -Name $name -Value (Resolve-RepoPath $value)
    }
}
$pluginDir = Join-Path $repoRoot 'plugins\transceiver'
$runtime = Join-Path $pluginDir 'scripts\reverse-runtime.mjs'
$pidPath = Join-Path $ControlDir 'processes.json'
$health = "http://127.0.0.1:$Port/healthz"
$verifiedCodexDir = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin\22cfb1d302613eae'
$bridgeEnvironment = @{
    TRANSCEIVER_REVERSE_PORT = [string]$Port
    CODEX_MCP_BRIDGE_DEFAULT_SANDBOX = $DefaultSandbox
    CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY = $DefaultAccessStrategy
    CODEX_MCP_BRIDGE_ALLOW_WRITE = $AllowWrite
    CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS = $AllowDangerFullAccess
}

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
    # PowerShell 7 may deserialize ISO timestamps as DateTime; keep their timezone.
    $expected = if ($entry.startedUtc -is [datetime]) { $entry.startedUtc.ToUniversalTime() }
        else { [datetime]::Parse([string]$entry.startedUtc).ToUniversalTime() }
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
function Test-Health([int]$TimeoutSec = 2) {
    try {
        $res = Invoke-RestMethod -Uri $health -TimeoutSec $TimeoutSec
        return ($res.ok -eq $true)
    } catch { return $false }
}
function Get-BridgeStartupElapsedMilliseconds($watch) { return $watch.Elapsed.TotalMilliseconds }
function Wait-BridgeHealthy($proc, $watch) {
    $budget = $BridgeStartupTimeoutSeconds * 1000
    $healthResult = 'not-checked'
    $attempts = 0
    $listenerPids = @()
    $ready = $false
    while ($true) {
        # Check exit before any potentially blocking network operation.
        $proc.Refresh()
        $exited = $proc.HasExited
        $elapsed = Get-BridgeStartupElapsedMilliseconds $watch
        $listenerPids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique)
        if ($exited -or $elapsed -ge $budget) { break }
        $remaining = $budget - (Get-BridgeStartupElapsedMilliseconds $watch)
        # PS 5.1 HTTP timeouts use whole seconds. Do not begin a request that
        # cannot fit in the remaining budget. OS query/scheduling overhead may remain.
        if ($listenerPids.Count -eq 1 -and [int]$listenerPids[0] -eq [int]$proc.Id -and $remaining -ge 1000) {
            $attempts++
            $healthy = Test-Health -TimeoutSec ([int][math]::Min(2, [math]::Floor($remaining / 1000)))
            $healthResult = if ($healthy) { 'passed' } else { 'failed' }
            $proc.Refresh()
            $exited = $proc.HasExited
            $listenerPids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique)
            if ($exited) { break }
            if ($healthy -and $listenerPids.Count -eq 1 -and [int]$listenerPids[0] -eq [int]$proc.Id -and
                (Get-BridgeStartupElapsedMilliseconds $watch) -lt $budget) { $ready = $true; break }
        }
        $remaining = $budget - (Get-BridgeStartupElapsedMilliseconds $watch)
        if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][math]::Min(500, [math]::Ceiling($remaining))) }
    }
    $reason = if ($ready) { 'healthy' } elseif ($exited) { 'process-exited' }
        elseif ($listenerPids.Count -eq 0) { 'port-not-listening' }
        elseif ($listenerPids.Count -ne 1 -or [int]$listenerPids[0] -ne [int]$proc.Id) { 'listener-pid-mismatch' }
        elseif ($healthResult -eq 'failed') { 'health-check-failed' } else { 'wait-timeout' }
    return [pscustomobject]@{
        Ready = $ready; Reason = $reason; ElapsedMs = [math]::Round((Get-BridgeStartupElapsedMilliseconds $watch))
        Exited = $exited; ExitCode = $(if ($exited) { if ($null -ne $proc.ExitCode) { $proc.ExitCode } else { 'unavailable' } } else { 'n/a' })
        ListenerPids = ($listenerPids -join ','); Health = $healthResult; HealthAttempts = $attempts
        TimedOut = (-not $ready -and -not $exited)
    }
}
function Write-BridgeStartupDiagnostic([string]$path, [string]$message) {
    $line = "$(Get-Date -Format o) $message"
    Write-Host $line
    Add-Content -LiteralPath $path -Value $line -Encoding UTF8
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

function Assert-CleanupPath([string]$path) {
    # Inspect every ancestor, not just the final directory/file. Never traverse a link.
    $current = [IO.Path]::GetFullPath($path)
    $ancestors = New-Object 'Collections.Generic.Stack[string]'
    while ($current) {
        $ancestors.Push($current)
        $parent = [IO.Path]::GetDirectoryName($current.TrimEnd('\','/'))
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
    }
    foreach ($ancestor in $ancestors) {
        $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse point in path' }
    }
}
function Test-CleanupPortListening {
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return [bool]@($listeners | Where-Object { $_.Port -eq $Port }).Count
}
function Get-CleanupProtection {
    # An absent record alone proves nothing. Inspect its parent and distinguish a
    # missing leaf from access errors; never follow a record or ancestor link.
    Assert-CleanupPath $ControlDir
    $recordExists = $true
    try { [void][IO.File]::GetAttributes($pidPath) }
    catch { if ($_.Exception.GetBaseException() -is [IO.FileNotFoundException]) { $recordExists = $false } else { throw } }
    if ($recordExists) {
        Assert-CleanupPath $pidPath
        $record = Read-Record
        if (-not $record -or [string]$record.configPath -ne $ConfigPath -or -not $record.logs) { throw 'incompatible controller record' }
    } else { $record = $null }
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    if (-not $recordExists -and (Test-CleanupPortListening)) { throw 'Bridge port has a listener' }
    $activePaths = @{}
    $verifiedIds = @()
    foreach ($component in $(if ($recordExists) { @('bridge','tunnel') } else { @() })) {
        $entry = $record.$component
        if ($null -eq $entry -or [int]$entry.pid -le 0 -or -not $entry.startedUtc) { throw 'incomplete process identity record' }
        try { [void][datetime]::Parse([string]$entry.startedUtc) } catch { throw 'invalid process creation time' }
        foreach ($suffix in @('Out','Err')) {
            $value = [string]$record.logs.($component + $suffix)
            if ([string]::IsNullOrWhiteSpace($value) -or -not [IO.Path]::IsPathRooted($value)) { throw 'log path is missing or relative' }
            [void][IO.Path]::GetFullPath($value)
        }
        $marker = if ($component -eq 'bridge') { 'reverse-runtime.mjs' } else { 'tunnel-client.exe' }
        $matchingPid = @($processes | Where-Object { [int]$_.ProcessId -eq [int]$entry.pid })
        if ($matchingPid.Count -eq 0) { continue }
        if (-not (Find-Process $entry $marker)) { throw 'recorded process identity cannot be verified' }
        $verifiedIds += [int]$entry.pid
        foreach ($suffix in @('Out','Err')) {
            $value = [string]$record.logs.($component + $suffix)
            if ([string]::IsNullOrWhiteSpace($value) -or -not [IO.Path]::IsPathRooted($value)) { throw 'active log path is missing or relative' }
            $activePaths[[IO.Path]::GetFullPath($value)] = $true
        }
    }
    foreach ($proc in $processes) {
        # An unreadable Node/Tunnel command line or an unrecorded runtime could
        # be a startup in progress (the controller writes its record only at success).
        if (($proc.Name -in @('node.exe','tunnel-client.exe') -and -not $proc.CommandLine) -or
            ($proc.CommandLine -and ($proc.CommandLine.Contains('reverse-runtime.mjs') -or $proc.Name -eq 'tunnel-client.exe') -and
                [int]$proc.ProcessId -notin $verifiedIds)) { throw 'unverified Bridge/Tunnel process detected' }
    }
    return $activePaths
}
function Initialize-LogCleanupNative {
    if ('BridgeLab.LogCleanup' -as [type]) { return }
    # Delete through the inspected handle, not a second path lookup. Ancestor
    # handles disallow rename/delete while the file is checked and removed.
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace BridgeLab {
 public static class LogCleanup {
  [StructLayout(LayoutKind.Sequential)] struct Info {
   public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
   public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string p, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info i);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h, int cls, ref byte value, uint size);
  static SafeFileHandle Open(string path, bool directory) {
   SafeFileHandle h = CreateFile(path, directory ? 0x80U : 0x10080U, directory ? 3U : 0U, IntPtr.Zero, 3, 0x00200000U | (directory ? 0x02000000U : 0U), IntPtr.Zero);
   if (h.IsInvalid) { int error=Marshal.GetLastWin32Error(); h.Dispose(); throw new Win32Exception(error, directory ? "cannot lock directory" : "cannot open log exclusively"); }
   return h;
  }
  static Info Inspect(SafeFileHandle h) {
   Info i; if (!GetFileInformationByHandle(h, out i)) throw new Win32Exception(Marshal.GetLastWin32Error(), "cannot inspect file handle");
   return i;
  }
  public static string Apply(string root, string path, DateTime cutoff, bool dryRun, bool all) {
   root=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
   path=Path.GetFullPath(path);
   if (!String.Equals(Path.GetDirectoryName(path),root,StringComparison.OrdinalIgnoreCase)) return "outside LogDir";
   var held=new List<SafeFileHandle>();
   try {
    var ancestors=new Stack<string>();
    for (var d=new DirectoryInfo(root); d!=null; d=d.Parent) ancestors.Push(d.FullName);
    foreach (string d in ancestors) {
     SafeFileHandle h;
     try { h=Open(d,true); } catch (Win32Exception e) { throw new Win32Exception(e.NativeErrorCode, "cannot lock directory at depth " + held.Count); }
     held.Add(h); var i=Inspect(h);
     if ((i.Attributes & 0x400U)!=0 || (i.Attributes & 0x10U)==0) return "unsafe directory";
    }
    using (var h=Open(path,false)) {
     var i=Inspect(h);
     if ((i.Attributes & (0x400U|0x10U|0x40U))!=0 || i.Links!=1) return "not an ordinary single-link file";
     long time=((long)i.Write.dwHighDateTime<<32)|(uint)i.Write.dwLowDateTime;
     if (!all && DateTime.FromFileTimeUtc(time)>=cutoff.ToUniversalTime()) return "retention changed";
     if (dryRun) return "would-delete";
     byte yes=1;
     if (!SetFileInformationByHandle(h,4,ref yes,1)) throw new Win32Exception(Marshal.GetLastWin32Error());
     return "deleted";
    }
   } finally { for (int n=held.Count-1;n>=0;n--) held[n].Dispose(); }
  }
 }
}
'@
}
function Remove-ControllerLogs {
    $counts = @{ Eligible=0; Deleted=0; Protected=0; Skipped=0; Failed=0; WouldDelete=0 }
    $cutoff = (Get-Date).AddDays(-$LogRetentionDays)
    $namePattern = '^(?:(?:bridge|tunnel)-.+-(?:out|err)\.log|bridge-.+-startup\.log|bridge-.+-out\.log\.startup\.log)$'
    try {
        Assert-CleanupPath $LogDir
        if (-not (Get-Item -LiteralPath $LogDir -Force).PSIsContainer) { throw 'LogDir is not a directory' }
        $files = @(Get-ChildItem -LiteralPath $LogDir -Force -ErrorAction Stop)
        $protection = $null
        $protectionFailure = $false
        try { $protection = Get-CleanupProtection } catch { $protectionFailure = $true; Write-Warning 'Cleanup withheld: controller record or process identity is unavailable/untrusted.' }
        foreach ($file in $files) {
            if ($file.Name -notmatch $namePattern -or $file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $counts.Skipped++; continue }
            if ($protectionFailure) { $counts.Skipped++; continue }
            if ($protection.ContainsKey($file.FullName)) { $counts.Protected++; continue }
            if (-not $All -and $file.LastWriteTime -ge $cutoff) { $counts.Skipped++; continue }
            try {
                # Re-read state and query identity before each candidate. Never use
                # a stale snapshot to delete a newly protected file.
                $currentProtection = Get-CleanupProtection
            } catch {
                $counts.Skipped++
                Write-Warning "Skipped $($file.Name): active log protection could not be revalidated."
                continue
            }
            if ($currentProtection.ContainsKey($file.FullName)) { $counts.Protected++; continue }
            try {
                Assert-CleanupPath $LogDir
                $current = Get-Item -LiteralPath $file.FullName -Force -ErrorAction Stop
                if ($current.PSIsContainer -or ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                    $current.Name -notmatch $namePattern -or $current.DirectoryName -ne $LogDir.TrimEnd('\','/') -or (-not $All -and $current.LastWriteTime -ge $cutoff)) {
                    $counts.Skipped++; Write-Host "Skipped $($file.Name): file conditions changed."; continue
                }
                Initialize-LogCleanupNative
                $counts.Eligible++
                $result = [BridgeLab.LogCleanup]::Apply($LogDir,$current.FullName,$cutoff,[bool]$DryRun,[bool]$All)
                if ($result -eq 'deleted') { $counts.Deleted++; Write-Host "Deleted: $($file.Name)" }
                elseif ($result -eq 'would-delete') { $counts.WouldDelete++; Write-Host "Would delete: $($file.Name)" }
                else { $counts.Eligible--; $counts.Skipped++; Write-Host "Skipped $($file.Name): $result." }
            } catch {
                $counts.Failed++
                # Exception messages may contain paths. Emit only the native code/type.
                $cause = $_.Exception.GetBaseException()
                $reason = if ($cause -is [ComponentModel.Win32Exception]) { "Windows error $($cause.NativeErrorCode): $($cause.Message)" } else { $cause.GetType().Name }
                Write-Warning "Failed $($file.Name): $reason"
            }
        }
    } catch { $counts.Failed++; Write-Warning 'Cleanup withheld: LogDir is missing, inaccessible or unsafe.' }
    Write-Host 'Log cleanup completed.'
    if ($All) { Write-Host "Retention: all historical logs" } else { Write-Host "Retention: $LogRetentionDays days" }
    Write-Host "Eligible: $($counts.Eligible)"
    Write-Host "Deleted: $($counts.Deleted)"
    Write-Host "Protected active: $($counts.Protected)"
    Write-Host "Skipped: $($counts.Skipped)"
    Write-Host "Failed: $($counts.Failed)"
    if ($DryRun) { Write-Host "Would delete: $($counts.WouldDelete) (DryRun: no files deleted)." }
    return [pscustomobject]$counts
}

function Confirm-LogCleanup {
    # Redirected/non-console input must never block an unattended job.
    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
        Write-Warning 'Cleanup cancelled: interactive input unavailable; use -Force for automation.'
        return $false
    }
    try { $answer = Read-Host 'Delete eligible historical logs? [y/N]' }
    catch { Write-Warning 'Cleanup cancelled: confirmation unavailable.'; return $false }
    return ($answer -ceq 'y' -or $answer -ceq 'Y')
}
switch ($Action) {
    'cleanup-logs' {
        if ($DryRun -or $Force -or (Confirm-LogCleanup)) { Remove-ControllerLogs | Out-Null }
        else { Write-Host 'Log cleanup cancelled.' }
        break
    }
    'status' { Show-Status; break }
    'start' {
        Assert-File $ConfigPath 'Bridge config'
        Assert-File $TunnelExe 'Tunnel client'
        Assert-File $GitExe 'Git executable'
        Assert-File $runtime 'Reverse runtime entry'
        if (-not (Test-Path -LiteralPath $ProfileDir -PathType Container)) { throw "Profile directory not found: $ProfileDir" }
        if (-not (Test-Path -LiteralPath $StateDir -PathType Container)) { throw "State directory not found: $StateDir" }

        # Reconcile controller-owned processes. Never adopt or stop unknown processes.
        $record = Read-Record
        if ($record -and $record.configPath -and [string]$record.configPath -ne $ConfigPath) {
            throw 'Controller record belongs to a different config path; refusing to reuse running processes.'
        }
        $managedBridge = $null
        $managedTunnel = $null
        if ($record) {
            $managedBridge = Find-Process $record.bridge 'reverse-runtime.mjs'
            $managedTunnel = Find-Process $record.tunnel 'tunnel-client.exe'
        }
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listener -and (-not $managedBridge -or [int]$listener.OwningProcess -ne [int]$managedBridge.ProcessId)) {
            throw "Port $Port is in use by a non-managed listener PID $($listener.OwningProcess); refusing to replace or adopt it."
        }
        if ($managedBridge -and -not (Test-Health)) {
            throw 'Managed Bridge is alive but unhealthy; refusing to terminate an active process automatically. Inspect status and logs.'
        }
        $existingTunnels = @(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue)
        $foreignTunnels = @($existingTunnels | Where-Object { -not $managedTunnel -or [int]$_.ProcessId -ne [int]$managedTunnel.ProcessId })
        if ($foreignTunnels.Count -gt 0) {
            throw 'Unmanaged tunnel-client.exe process detected. Inspect it before starting; refusing to adopt or create a duplicate.'
        }
        if ($managedBridge -and $managedTunnel) {
            Write-Host 'Bridge and Tunnel are already managed and running. No restart needed.'
            Show-Status
            break
        }

        $prior = @{}
        foreach ($k in @('TRANSCEIVER_CONFIG','TRANSCEIVER_STATE_DIR','TRANSCEIVER_GIT_EXECUTABLE','CONTROL_PLANE_API_KEY','CONTROL_PLANE_TUNNEL_ID','PATH') + @($bridgeEnvironment.Keys)) {
            $prior[$k] = [Environment]::GetEnvironmentVariable($k,'Process')
        }
        $newBridge = $null
        $newTunnel = $null
        try {
            # Keep the exact record entries for processes that remain alive.
            $bridgeInfo = if ($managedBridge) { $record.bridge } else { $null }
            $tunnelInfo = if ($managedTunnel) { $record.tunnel } else { $null }
            $bridgeOut = if ($record -and $record.logs) { [string]$record.logs.bridgeOut } else { $null }
            $bridgeErr = if ($record -and $record.logs) { [string]$record.logs.bridgeErr } else { $null }
            $tunnelOut = if ($record -and $record.logs) { [string]$record.logs.tunnelOut } else { $null }
            $tunnelErr = if ($record -and $record.logs) { [string]$record.logs.tunnelErr } else { $null }
            $selectedCodexExe = if ($record -and $record.codexExe) { [string]$record.codexExe } else { $null }

            if (-not $managedBridge) {
                if ($listener) { throw "Port $Port has an unexpected listener; refusing Bridge startup." }
                $node = Resolve-Executable $NodeExe
                foreach ($key in $bridgeEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key,$bridgeEnvironment[$key],'Process') }
                $env:TRANSCEIVER_CONFIG = $ConfigPath
                $env:TRANSCEIVER_STATE_DIR = $StateDir
                $env:TRANSCEIVER_GIT_EXECUTABLE = $GitExe
                $selectedCodexBin = Resolve-CodexBin
                $selectedCodexExe = Join-Path $selectedCodexBin 'codex.exe'
                $env:PATH = "$selectedCodexBin;$env:PATH"
                $bridgeLogs = New-LogPaths 'bridge'
                $startupLog = $bridgeLogs.Out -replace '-out\.log$', '-startup.log'
                $startupWatch = [Diagnostics.Stopwatch]::StartNew()
                Write-BridgeStartupDiagnostic $startupLog "Bridge startup: budgetSeconds=$BridgeStartupTimeoutSeconds; port=$Port"
                $newBridge = Start-Process -FilePath $node -ArgumentList @('"' + $runtime + '"') -WorkingDirectory $pluginDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $bridgeLogs.Out -RedirectStandardError $bridgeLogs.Err
                # Retain a process handle so Windows can report the exit code even
                # after the child exits. It may already be gone before Handle opens.
                try { $null = $newBridge.Handle } catch { if (-not $newBridge.HasExited) { throw } }
                $bridgeOut = $bridgeLogs.Out
                $bridgeErr = $bridgeLogs.Err
                $startup = Wait-BridgeHealthy $newBridge $startupWatch
                Write-BridgeStartupDiagnostic $startupLog "Bridge startup: pid=$($newBridge.Id); result=$($startup.Reason); elapsedMs=$($startup.ElapsedMs); exited=$($startup.Exited); exitCode=$($startup.ExitCode); listenerPids=[$($startup.ListenerPids)]; health=$($startup.Health); healthAttempts=$($startup.HealthAttempts); timedOut=$($startup.TimedOut)"
                if (-not $startup.Ready) { throw "Bridge did not become healthy: $($startup.Reason); timedOut=$($startup.TimedOut). Review: $startupLog, $bridgeOut and $bridgeErr" }
                $bridgeInfo = New-Entry $newBridge
                Write-Host "Started missing Bridge PID $($newBridge.Id)."
            }
            if (-not $managedTunnel) {
                # The normal controller path maps persistent credentials to the names
                # expected by tunnel-client. Values are never persisted to logs or JSON.
                $tunnelKey = Resolve-TunnelCredential 'OpenAI_Tunnel_API_KEY'
                $tunnelId = Resolve-TunnelCredential 'Tunnel_ID'
                if ([string]::IsNullOrWhiteSpace($tunnelKey) -or [string]::IsNullOrWhiteSpace($tunnelId)) {
                    throw 'Missing user credentials: OpenAI_Tunnel_API_KEY and/or Tunnel_ID. Configure Windows user environment variables.'
                }
                if (-not $tunnelId.StartsWith('tunnel_')) {
                    throw 'Tunnel_ID must contain the full ID, including its tunnel_ prefix.'
                }
                $env:CONTROL_PLANE_API_KEY = $tunnelKey
                $env:CONTROL_PLANE_TUNNEL_ID = $tunnelId
                $tunnelLogs = New-LogPaths 'tunnel'
                $newTunnel = Start-Process -FilePath $TunnelExe -ArgumentList @('run','--profile',$TunnelProfile,'--profile-dir',('"' + $ProfileDir + '"')) -WorkingDirectory (Split-Path -Parent $TunnelExe) -PassThru -WindowStyle Hidden -RedirectStandardOutput $tunnelLogs.Out -RedirectStandardError $tunnelLogs.Err
                $tunnelInfo = New-Entry $newTunnel
                $tunnelOut = $tunnelLogs.Out
                $tunnelErr = $tunnelLogs.Err
                Start-Sleep -Seconds 2
                $newTunnel.Refresh()
                if ($newTunnel.HasExited) { throw "Tunnel Client exited at startup. Review: $tunnelOut and $tunnelErr" }
                Write-Host "Started missing Tunnel PID $($newTunnel.Id)."
            }
            # Write one complete record only after successful reconciliation.
            Write-Record @{ version = 2; bridge = $bridgeInfo; tunnel = $tunnelInfo; configPath = $ConfigPath; codexExe = $selectedCodexExe; logs = @{ bridgeOut=$bridgeOut; bridgeErr=$bridgeErr; tunnelOut=$tunnelOut; tunnelErr=$tunnelErr } }
            Show-Status
        }
        catch {
            # Roll back only new processes launched by this invocation. Existing
            # controller-owned processes and the previous PID record are untouched.
            if ($newTunnel) {
                $newTunnel.Refresh()
                if (-not $newTunnel.HasExited) { Stop-Process -Id $newTunnel.Id -ErrorAction SilentlyContinue }
            }
            if ($newBridge) {
                $newBridge.Refresh()
                if (-not $newBridge.HasExited) { Stop-Process -Id $newBridge.Id -ErrorAction SilentlyContinue }
            }
            throw
        }
        finally {
            Remove-Variable tunnelKey -ErrorAction SilentlyContinue
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
