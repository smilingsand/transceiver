#requires -Version 5.1
<#
Offline, read-only operator diagnostics. No child processes, RPC, environment
dump, SQLite access, credential lookup, service control or permission changes.
Paths are relative to this checkout unless absolute. Output is JSON by default.
#>
[CmdletBinding()]
param(
    [string]$ConfigPath = 'config.json',
    [string]$BridgeEnvPath = 'bridge.env',
    [string]$RuntimeDir = 'runtime',
    [string]$Project = '',
    [string]$Cwd = '',
    [ValidateSet('read-only','workspace-write','danger-full-access')][string]$RequestedSandbox,
    [switch]$CheckPython,
    [string]$PythonPath = '',
    [string]$UvPath = '',
    [string]$VenvPath = '',
    [switch]$AsObject
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Get-LocalPath([string]$Value, [string]$Base = $repoRoot) {
    if (-not $Value -or $Value -match '[\x00-\x1f*?]' -or $Value -match '^[\\/]{2}') { throw 'Expected a local path.' }
    if (-not [IO.Path]::IsPathRooted($Value)) { $Value = Join-Path $Base $Value }
    $full = [IO.Path]::GetFullPath($Value)
    if ($full -notmatch '^[A-Za-z]:[\\/]' -or $full.Substring(2).Contains(':')) { throw 'Expected a local drive path without streams.' }
    if ($full -eq [IO.Path]::GetPathRoot($full)) { return $full }
    return $full.TrimEnd('\','/')
}
function Test-PlainPath([string]$Full) {
    # Check ancestors too; do not follow junctions into other directories.
    $current = [IO.Path]::GetPathRoot($Full)
    foreach ($part in $Full.Substring($current.Length).Split([char[]]'\/',[StringSplitOptions]::RemoveEmptyEntries)) {
        $current = Join-Path $current $part
        try { $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop }
        catch { return 'missing-or-inaccessible' }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return 'reparse-blocked' }
    }
    return 'plain'
}
function Read-BoundedText([string]$Path, [int]$Limit = 262144) {
    $stream = $null
    try {
        $full = Get-LocalPath $Path
        $state = Test-PlainPath $full
        if ($state -ne 'plain') { return @{ status=$state; text=$null } }
        $stream = [IO.File]::Open($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $bytes = New-Object byte[] ($Limit + 1)
        $count = 0
        while ($count -lt $bytes.Length) {
            $read = $stream.Read($bytes, $count, $bytes.Length - $count)
            if ($read -eq 0) { break }
            $count += $read
        }
        if ($count -gt $Limit) { return @{ status='too-large'; text=$null } }
        $encoding = New-Object Text.UTF8Encoding($false, $true)
        return @{ status='read'; text=$encoding.GetString($bytes,0,$count).TrimStart([char]0xFEFF) }
    } catch { return @{ status='unavailable-or-invalid'; text=$null } }
    finally { if ($stream) { $stream.Dispose() } }
}
function Get-Field($Object, [string]$Name) {
    if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    return $null
}
function Get-PathObservation([string]$Path) {
    try { $full = Get-LocalPath $Path } catch { return @{ status='invalid-local-path'; executionAccess='unknown-not-executed' } }
    $state = Test-PlainPath $full
    $readable = $null; $aclReadable = $null; $kind = 'unknown'
    if ($state -eq 'plain') {
        $item = Get-Item -LiteralPath $full -Force
        $kind = if ($item.PSIsContainer) { 'directory' } else { 'file' }
        if ($kind -eq 'file') {
            $stream = $null
            try { $stream = [IO.File]::OpenRead($full); [void]$stream.ReadByte(); $readable = $true }
            catch { $readable = $false }
            finally { if ($stream) { $stream.Dispose() } }
        }
        try { $null = Get-Acl -LiteralPath $full -ErrorAction Stop; $aclReadable = $true }
        catch { $aclReadable = $false }
    }
    return @{ path=$full; status=$state; kind=$kind; fileReadable=$readable; aclReadable=$aclReadable;
        executionAccess='unknown-not-executed' }
}
function Find-Application([string]$Name) {
    $command = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

# Same literal syntax as the controller; retain only diagnostic whitelist values.
$allowedKeys = @('TUNNEL_PROFILE','TUNNEL_EXE','GIT_EXE','CODEX_BIN','CODEX_VERSION','NODE_EXE','PORT',
    'BRIDGE_STARTUP_TIMEOUT_SECONDS','LOG_RETENTION_DAYS','CODEX_MCP_BRIDGE_DEFAULT_SANDBOX',
    'CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY','CODEX_MCP_BRIDGE_ALLOW_WRITE','CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS')
$settings = @{}
$envFile = Read-BoundedText $BridgeEnvPath
$envStatus = $envFile.status
if ($envStatus -eq 'read') {
    $seen = @{}
    foreach ($line in ($envFile.text -split "`n")) {
        $text = $line.Trim()
        if (-not $text -or $text.StartsWith('#')) { continue }
        if ($text -notmatch '^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') { $envStatus='invalid-syntax'; break }
        $key=$Matches[1]; $value=$Matches[2]
        if ($key -notin $allowedKeys -or $seen.ContainsKey($key)) { $envStatus='unsupported-or-duplicate-key'; break }
        $seen[$key]=$true
        if ($value.StartsWith('"') -or $value.StartsWith("'")) {
            $quote=[regex]::Escape($value.Substring(0,1))
            if ($value -notmatch "^$quote(.*?)$quote\s*(?:#.*)?$") { $envStatus='invalid-syntax'; break }
            $value=$Matches[1]
        } else { $value=($value -replace '\s+#.*$', '').Trim() }
        if ($key -eq 'CODEX_BIN' -or $key.StartsWith('CODEX_MCP_BRIDGE_')) { $settings[$key]=$value }
    }
}
function Get-Setting([string]$Key, [string]$Default, [string[]]$Choices) {
    $value=$Default; $source='controller-default'
    if ($settings.ContainsKey($Key)) { $value=$settings[$Key]; $source='bridge.env' }
    $valid=($value -cin $Choices) -and $envStatus -eq 'read'
    if ($value -cnotin $Choices) { $value=$null }
    return @{ value=$value; source=$source; valid=$valid }
}
$sandbox=Get-Setting 'CODEX_MCP_BRIDGE_DEFAULT_SANDBOX' 'read-only' @('read-only','workspace-write','danger-full-access')
$strategy=Get-Setting 'CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY' 'read-only' @('read-only','adaptive','always-full')
$write=Get-Setting 'CODEX_MCP_BRIDGE_ALLOW_WRITE' '0' @('0','1')
$full=Get-Setting 'CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS' '0' @('0','1')
$candidate=$sandbox.value; $candidateSource='configured-default-sandbox'
if ($strategy.value -eq 'read-only') { $candidate='read-only'; $candidateSource='configured-strategy' }
elseif ($strategy.value -eq 'always-full') { $candidate='danger-full-access'; $candidateSource='configured-strategy' }
elseif ($RequestedSandbox) { $candidate=$RequestedSandbox; $candidateSource='explicit-diagnostic-request' }
$valid=$sandbox.valid -and $strategy.valid -and $write.valid -and $full.valid
# Startup constraints apply even when a requested sandbox would be narrower.
$permitted=$valid -and -not ($sandbox.value -eq 'workspace-write' -and $write.value -ne '1') -and
    -not ($sandbox.value -eq 'danger-full-access' -and $full.value -ne '1') -and
    -not ($strategy.value -eq 'always-full' -and $full.value -ne '1') -and
    -not ($candidate -eq 'workspace-write' -and $write.value -ne '1') -and
    -not ($candidate -eq 'danger-full-access' -and $full.value -ne '1')
$policyFile='plugins/transceiver/scripts/reverse-runtime.mjs'
$policyText=Read-BoundedText $policyFile 32768
$approval=$null; $approvalLine=$null
if ($policyText.status -eq 'read') {
    $assignment=[regex]::Match($policyText.text, 'CODEX_MCP_BRIDGE_APPROVAL_POLICY:\s*"never"')
    if ($assignment.Success) {
        $approval='never'
        $approvalLine=$policyText.text.Substring(0,$assignment.Index).Split("`n").Length
    }
}

$cwdFull=if ($Cwd) { Get-LocalPath $Cwd } else { $repoRoot }
$authorization=@{ status='unknown'; project=$Project; cwd=$cwdFull; authoritative=$false }
$configFile=Read-BoundedText $ConfigPath
if ($configFile.status -eq 'read') {
    try {
        $config=$configFile.text | ConvertFrom-Json
        if ((Get-Field $config 'version') -ne 1 -or $null -eq (Get-Field $config 'projects')) { throw 'Invalid config' }
        $matches=@($config.projects.PSObject.Properties | Where-Object {
            $name=Get-Field $_.Value 'name'
            if (-not $name) { $name=Split-Path $_.Name -Leaf }
            if ($Project) { $name -ceq $Project } else {
                $root=Get-LocalPath $_.Name
                $cwdFull.Equals($root,[StringComparison]::OrdinalIgnoreCase) -or $cwdFull.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)
            }
        })
        if ($matches.Count -eq 1) {
            $entry=$matches[0]; $root=Get-LocalPath $entry.Name
            $within=$cwdFull.Equals($root,[StringComparison]::OrdinalIgnoreCase) -or $cwdFull.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)
            $sync=Get-Field $entry.Value 'sync'; $allow=Get-Field $entry.Value 'allowCodexTasks'
            $enabled=$sync -is [bool] -and $sync -and $allow -is [bool] -and $allow
            $plain=$root.Length -gt 3 -and (Test-PlainPath $root) -eq 'plain' -and (Test-PlainPath $cwdFull) -eq 'plain'
            if ($plain) { $plain=(Get-Item -LiteralPath $root -Force).PSIsContainer -and (Get-Item -LiteralPath $cwdFull -Force).PSIsContainer }
            $authorization.root=$root; $authorization.cwdWithinRoot=$within; $authorization.configuredEnabled=$enabled
            $authorization.status=if ($enabled -and $within -and $plain) { 'configured-candidate' } else { 'not-eligible' }
        } else { $authorization.status='not-found-or-ambiguous' }
    } catch { $authorization.status='invalid-or-unavailable-config' }
} else { $authorization.status=$configFile.status }

$recordPath=Join-Path (Get-LocalPath $RuntimeDir) 'control\processes.json'
$record=Read-BoundedText $recordPath
$recordedCodex=$null
if ($record.status -eq 'read') {
    try { $recordedCodex=Get-Field ($record.text | ConvertFrom-Json) 'codexExe' } catch { $record.status='invalid-json' }
}
$configuredCodex=$null
if ($settings.ContainsKey('CODEX_BIN')) {
    try { $configuredCodex=Get-PathObservation (Join-Path (Get-LocalPath $settings.CODEX_BIN) 'codex.exe') }
    catch { $configuredCodex=@{ status='invalid-local-path'; executionAccess='unknown-not-executed' } }
}
$codexOnPath=Find-Application 'codex.exe'
$python=$null
if ($CheckPython -or $PythonPath -or $UvPath -or $VenvPath) {
    $python=@{ observer='current-script-account'; python=$null; uv=$null; venv=$null }
    foreach ($pair in @(@('python',$PythonPath,'python.exe'),@('uv',$UvPath,'uv.exe'))) {
        $selected=$pair[1]; $source='explicit-path'
        if (-not $selected) { $selected=Find-Application $pair[2]; $source='PATH-application-candidate' }
        $python[$pair[0]]=@{ source=$source; observation=$(if ($selected) { Get-PathObservation $selected } else { @{ status='not-found' } }) }
    }
    if ($VenvPath) {
        $venv=Get-LocalPath $VenvPath
        $cfg=Read-BoundedText (Join-Path $venv 'pyvenv.cfg') 16384
        $references=@()
        if ($cfg.status -eq 'read') {
            foreach ($line in ($cfg.text -split "`n")) {
                if ($line -match '^\s*(home|base-executable|executable)\s*=\s*(.*?)\s*$') {
                    $key=$Matches[1]; $value=$Matches[2]
                    try {
                        $target=Get-LocalPath $value $venv
                        if ($key -eq 'home') { $target=Join-Path $target 'python.exe' }
                        $references+=@{ field=$key; observation=(Get-PathObservation $target) }
                    } catch { $references+=@{ field=$key; observation=@{ status='invalid-local-path' } } }
                }
            }
        }
        $python.venv=@{ path=$venv; configStatus=$cfg.status; launcher=(Get-PathObservation (Join-Path $venv 'Scripts\python.exe')); baseReferences=$references }
    }
}
$result=[ordered]@{
    schemaVersion=1; mode='offline-read-only'; observerAccount=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    inputPaths=@{ bridgeEnv=(Get-LocalPath $BridgeEnvPath); config=(Get-LocalPath $ConfigPath); runtime=(Get-LocalPath $RuntimeDir) }
    controllerConfiguration=@{ envStatus=$envStatus; defaultSandbox=$sandbox; accessStrategy=$strategy; allowWrite=$write; allowDangerFullAccess=$full
        sandboxCandidate=@{ value=$candidate; source=$candidateSource; permittedByConfiguredLimits=[bool]$permitted; conditionalOn='no launch overrides or saved-strategy override' } }
    repositoryApprovalPolicy=@{ value=$approval; status=$(if ($approval) { 'observed-source' } else { 'unknown' }); source=$policyFile; line=$approvalLine; inheritedEnvironmentOverridesThis=$(if ($approval) { $false } else { $null }) }
    appServerActual=@{ status='unknown-not-queried'; sandbox=$null; approvalPolicy=$null; cwd=$null; windowsSandbox=$null
        reason='No live RPC, process inspection or rollout read. config/read alone would not establish thread overrides.' }
    savedStrategy=@{ status='unknown-not-queried'; reason='Persistent SQLite settings not opened; they may override controller strategy.' }
    projectAuthorization=$authorization
    codexExecutables=@{ configured=$configuredCodex; recorded=$(if ($recordedCodex -is [string] -and $recordedCodex) { Get-PathObservation $recordedCodex } else { $null }); recordStatus=$record.status
        onPathCandidate=$(if ($codexOnPath) { Get-PathObservation $codexOnPath } else { $null }); actualRunningExecutable='unknown'; controllerUsesPathFallback=$false }
    pythonChecks=$python
    limitations=@('File readability and ACL readability do not prove execute access or DLL availability.',
        'Observations apply to this account, not automatically to Codex sandbox users.',
        'Configuration candidates are not server authorization; server revalidates identity, links and grants.',
        'Controller launch overrides, saved settings and running threads are not observed.')
}
if ($AsObject) { [pscustomobject]$result } else { $result | ConvertTo-Json -Depth 12 }
