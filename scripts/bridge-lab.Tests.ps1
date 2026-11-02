#requires -Version 5.1
# Offline: load setup/functions; dispatch uses fake process/network operations only.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null; $errors = $null
$source = Join-Path $PSScriptRoot 'bridge-lab.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$dispatch = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.SwitchStatementAst] })
if ($dispatch.Count -ne 1) { throw 'Expected one action dispatch' }
$fixtureParent = Join-Path (Split-Path $PSScriptRoot -Parent) 'codex'
$fixture = Join-Path $fixtureParent ('bridge-controller-' + [guid]::NewGuid())
$fixtureScripts = Join-Path $fixture 'scripts'
New-Item -ItemType Directory -Path $fixtureScripts -Force | Out-Null
$controller = Join-Path $fixtureScripts 'bridge-lab.ps1'
[IO.File]::WriteAllText($controller, $ast.Extent.Text.Substring(0,$dispatch[0].Extent.StartOffset), (New-Object Text.UTF8Encoding($true)))
$envFile = Join-Path $fixture 'bridge.env'
function Check($actual,$expected) {
    if ($actual -cne $expected) { throw "Expected [$expected], got [$actual]" }
}
function Write-Env([string]$text,[bool]$bom=$false) {
    [IO.File]::WriteAllText($envFile,$text,(New-Object Text.UTF8Encoding($bom)))
}
$location = Get-Location
try {
    Set-Location ([IO.Path]::GetTempPath())
    . $controller
    Check $repoRoot $fixture
    Check $ConfigPath (Join-Path $fixture 'config.json')
    foreach ($pair in @{ StateDir='state'; ProfileDir='tunnel-profiles'; ControlDir='control'; LogDir='logs' }.GetEnumerator()) {
        Check (Get-Variable $pair.Key -ValueOnly) (Join-Path $fixture ('runtime\' + $pair.Value))
    }
    Check $AllowWrite '0'
    Check $BridgeStartupTimeoutSeconds 30
    Check $LogRetentionDays 7
    Write-Env @'
# UTF-8 注释
TUNNEL_PROFILE=测试 profile # comment
TUNNEL_EXE="C:\Program Files\Tunnel #1\tunnel-client.exe" # comment
GIT_EXE='C:\Program Files\Git\git.exe'
CODEX_BIN=tools\Codex With Spaces
CODEX_VERSION=test-version
NODE_EXE=node.exe
PORT=9988
BRIDGE_STARTUP_TIMEOUT_SECONDS=45
LOG_RETENTION_DAYS=7
CODEX_MCP_BRIDGE_DEFAULT_SANDBOX=workspace-write
CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY=read-only
CODEX_MCP_BRIDGE_ALLOW_WRITE=1
CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS=0
'@
    $before = [Environment]::GetEnvironmentVariable('CODEX_MCP_BRIDGE_ALLOW_WRITE','Process')
    . $controller
    Check $TunnelProfile '测试 profile'
    Check $TunnelExe 'C:\Program Files\Tunnel #1\tunnel-client.exe'
    Check $GitExe 'C:\Program Files\Git\git.exe'
    Check $CodexBin (Join-Path $fixture 'tools\Codex With Spaces')
    Check $ExpectedCodexVersion 'test-version'
    Check $NodeExe 'node.exe'
    Check $Port 9988
    Check $BridgeStartupTimeoutSeconds 45
    Check $LogRetentionDays 7
    Check $bridgeEnvironment.TRANSCEIVER_REVERSE_PORT '9988'
    Check $bridgeEnvironment.CODEX_MCP_BRIDGE_DEFAULT_SANDBOX 'workspace-write'
    Check $bridgeEnvironment.CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY 'read-only'
    Check $bridgeEnvironment.CODEX_MCP_BRIDGE_ALLOW_WRITE '1'
    Check $bridgeEnvironment.CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS '0'
    Check ([Environment]::GetEnvironmentVariable('CODEX_MCP_BRIDGE_ALLOW_WRITE','Process')) $before
    . $controller -Port 8877 -BridgeStartupTimeoutSeconds 12 -TunnelProfile explicit -AllowWrite 0 -ConfigPath 'elsewhere\config.json' -RuntimeDir 'data dir'
    Check $BridgeStartupTimeoutSeconds 12
    Check $Port 8877
    Check $TunnelProfile 'explicit'
    Check $AllowWrite '0'
    Check $ConfigPath (Join-Path $fixture 'elsewhere\config.json')
    Check $ControlDir (Join-Path $fixture 'data dir\control')
    Check $LogDir (Join-Path $fixture 'data dir\logs')
    . $controller -ControlDir 'legacy\control' -LogDir 'custom logs' -StateDir 'custom state' -ProfileDir 'custom profiles'
    Check $pidPath (Join-Path $fixture 'legacy\control\processes.json')
    Check $LogDir (Join-Path $fixture 'custom logs')
    Check $StateDir (Join-Path $fixture 'custom state')
    Check $ProfileDir (Join-Path $fixture 'custom profiles')
    . $controller -LogRetentionDays 14
    Check $LogRetentionDays 14
    Write-Env 'TUNNEL_PROFILE=中文' $true
    . $controller
    Check $TunnelProfile '中文'
    Write-Env 'TUNNEL_PROFILE=$(throw "must not execute")'
    . $controller
    Check $TunnelProfile '$(throw "must not execute")'
    foreach ($bad in @('PORT=0','PORT=65536','PORT=abc','CODEX_MCP_BRIDGE_ALLOW_WRITE=true','OpenAI_Tunnel_API_KEY=forbidden','Tunnel_ID=forbidden','UNKNOWN=value',"PORT=1234`nPORT=2345",'TUNNEL_PROFILE="unclosed','not an assignment')) {
        Write-Env $bad
        $rejected = $false
        try { & $controller } catch { $rejected = $true }
        if (-not $rejected) { throw 'Invalid configuration accepted' }
    }
    [IO.File]::WriteAllBytes($envFile,[byte[]]@(0xC3,0x28))
    $rejected = $false
    try { & $controller } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid UTF-8 accepted' }
    foreach ($bad in @('0','3601','abc','1.5','999999999999999999999')) {
        Write-Env "BRIDGE_STARTUP_TIMEOUT_SECONDS=$bad"
        $rejected = $false
        try { & $controller } catch { $rejected = $true }
        if (-not $rejected) { throw 'Invalid startup timeout accepted' }
    }
    foreach ($bad in @(0,3601)) {
        $rejected = $false
        try { & $controller -BridgeStartupTimeoutSeconds $bad } catch { $rejected = $true }
        if (-not $rejected) { throw 'Invalid explicit startup timeout accepted' }
    }
    # Fake CIM metadata; no real process operations.
    foreach ($bad in @('0','3651','-1','abc','1.5','999999999999999999999')) {
        Write-Env "LOG_RETENTION_DAYS=$bad"
        $rejected = $false
        try { & $controller } catch { $rejected = $true }
        if (-not $rejected) { throw 'Invalid retention accepted' }
    }
    foreach ($bad in @(0,3651,-1)) {
        $rejected = $false
        try { & $controller -LogRetentionDays $bad } catch { $rejected = $true }
        if (-not $rejected) { throw 'Invalid explicit retention accepted' }
    }
    Write-Env 'LOG_RETENTION_DAYS=7'
    foreach ($action in @('status','start','stop')) {
        $message = ''
        try { & $controller -Action $action -All } catch { $message = $_.Exception.Message }
        if ($message -notlike '*only valid*cleanup-logs*') { throw "Wrong action was not clearly rejected: $action" }
    }
    $message = ''
    try { & $controller -Action cleanup-logs -All -LogRetentionDays 7 } catch { $message = $_.Exception.Message }
    if ($message -notlike '*cannot be combined*LogRetentionDays*') { throw 'Conflicting retention was not clearly rejected' }
    Write-Env 'LOG_RETENTION_DAYS=0'
    $message = ''
    try { & $controller -Action cleanup-logs -All } catch { $message = $_.Exception.Message }
    if ($message -notlike '*LOG_RETENTION_DAYS*1 to 3650*') { throw 'All accepted invalid environment retention' }
    Write-Env 'LOG_RETENTION_DAYS=7'
    function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) return $script:fakeProcess }
    $started = [datetime]::UtcNow
    $entry = @{ pid=123; startedUtc=$started.ToString('o') }
    $script:fakeProcess = [pscustomobject]@{ CommandLine='node reverse-runtime.mjs'; CreationDate=$started }
    Check ([bool](Find-Process $entry 'reverse-runtime.mjs')) $true
    Check ([bool](Find-Process $entry 'tunnel-client.exe')) $false
    $script:fakeProcess.CreationDate = $started.AddSeconds(20)
    Check ([bool](Find-Process $entry 'reverse-runtime.mjs')) $false
    $script:fakeProcess = $null
    Check ([bool](Find-Process $entry 'reverse-runtime.mjs')) $false
    # Dispatch regression: existing managed components must be retained by start,
    # reported by status and exclusively selected by stop. All OS calls are fake.
    Remove-Item -LiteralPath $envFile
    . $controller
    New-Item -ItemType Directory -Force -Path $StateDir,$ProfileDir | Out-Null
    function Assert-File { param($p,$name) }
    $script:bridge = [pscustomobject]@{ ProcessId=123; CommandLine='node reverse-runtime.mjs'; CreationDate=$started }
    $script:tunnel = [pscustomobject]@{ ProcessId=456; CommandLine='tunnel-client.exe run'; CreationDate=$started }
    function Get-CimInstance {
        param($ClassName,$Filter,$ErrorAction)
        if ($Filter -eq 'ProcessId=123') { return $script:bridge }
        return $script:tunnel
    }
    function Get-NetTCPConnection { param($LocalPort,$State,$ErrorAction) return [pscustomobject]@{ OwningProcess=123 } }
    function Test-Health { return $true }
    function Start-Process { throw 'Unexpected process launch in managed-start test' }
    $script:stopped = @()
    function Stop-Process { param($Id,$ErrorAction) $script:stopped += $Id }
    Write-Record @{ configPath=$ConfigPath; bridge=$entry; tunnel=@{pid=456;startedUtc=$started.ToString('o')}; logs=$null }
    Check ([bool](Find-Process (Read-Record).bridge 'reverse-runtime.mjs')) $true
    $runAction = [scriptblock]::Create($dispatch[0].Extent.Text)
    $Action = 'start'
    & $runAction
    Check $script:stopped.Count 0
    Check ([bool](Read-Record)) $true
    $Action = 'status'
    & $runAction
    Check $script:stopped.Count 0
    # A reused Tunnel PID must never be terminated by stop.
    $script:tunnel.CreationDate = $started.AddSeconds(20)
    $Action = 'stop'
    & $runAction
    Check $script:stopped.Count 1
    Check $script:stopped[0] 123
    Check (Test-Path -LiteralPath $pidPath) $false
    # Deterministic startup scenarios: fake time, process, listener and HTTP only.
    # Run the real action dispatch, including rollback and record preservation.
    function Get-BridgeStartupElapsedMilliseconds { param($watch) return $script:elapsed }
    function Start-Sleep { param($Milliseconds,$Seconds) $script:elapsed += $Milliseconds + 1000 * $Seconds }
    function Resolve-Executable { param($value) return 'fake-node.exe' }
    function Resolve-CodexBin { return $fixture }
    function New-Entry { param($proc) return @{ pid=$proc.Id; startedUtc=$started.ToString('o') } }
    function Start-Process {
        param($FilePath,$ArgumentList,$WorkingDirectory,[switch]$PassThru,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError)
        $script:launches++
        return $script:child
    }
    function Get-CimInstance {
        param($ClassName,$Filter,$ErrorAction)
        if ($Filter -ne 'ProcessId=123') { return $script:tunnel }
    }
    function Get-NetTCPConnection {
        param($LocalPort,$State,$ErrorAction)
        if ($script:launches -eq 0 -or $script:scenario -in @('no-listener','exit-immediately','exit-later')) { return }
        if ($script:scenario -eq 'slow-success' -and $script:elapsed -lt 12000) { return }
        return [pscustomobject]@{ OwningProcess=$(if ($script:scenario -eq 'foreign-listener') { 999 } else { 123 }) }
    }
    function Test-Health {
        param($TimeoutSec)
        $script:healthCalls++
        if ($script:scenario -eq 'unhealthy') { $script:elapsed += $TimeoutSec * 1000; return $false }
        if ($script:scenario -eq 'deadline-health') { $script:elapsed = 30000 }
        if ($script:scenario -eq 'exit-during-health') { $script:child.HasExited = $true }
        return $true
    }
    $script:tunnel.CreationDate = $started
    foreach ($case in @(
        @{Name='no-listener'; Reason='port-not-listening'; Health='not-checked'; Exit=$false},
        @{Name='exit-immediately'; Reason='process-exited'; Health='not-checked'; Exit=$true},
        @{Name='exit-later'; Reason='process-exited'; Health='not-checked'; Exit=$true},
        @{Name='unhealthy'; Reason='health-check-failed'; Health='failed'; Exit=$false},
        @{Name='foreign-listener'; Reason='listener-pid-mismatch'; Health='not-checked'; Exit=$false},
        @{Name='deadline-health'; Reason='wait-timeout'; Health='passed'; Exit=$false},
        @{Name='exit-during-health'; Reason='process-exited'; Health='passed'; Exit=$true},
        @{Name='success'; Reason='healthy'; Health='passed'; Exit=$false},
        @{Name='slow-success'; Reason='healthy'; Health='passed'; Exit=$false}
    )) {
        $script:scenario = $case.Name
        $script:elapsed = 0; $script:launches = 0; $script:healthCalls = 0; $script:stopped = @()
        $script:child = [pscustomobject]@{ Id=123; Handle=1; HasExited=($case.Name -eq 'exit-immediately'); ExitCode=17 }
        $script:child | Add-Member ScriptMethod Refresh {
            if ($script:scenario -eq 'exit-later' -and $script:elapsed -ge 500) { $this.HasExited = $true }
        }
        $BridgeStartupTimeoutSeconds = 30
        Write-Record @{ configPath=$ConfigPath; bridge=$null; tunnel=@{pid=456;startedUtc=$started.ToString('o')}; logs=$null; codexExe=$null }
        $oldRecord = Get-Content -LiteralPath $pidPath -Raw
        $priorPath = $env:PATH
        $Action = 'start'; $failure = $null
        try { & $runAction } catch { $failure = $_ }
        if ($script:launches -ne 1) { throw "Startup scenario $($case.Name) did not launch: $failure" }
        Check $script:launches 1
        Check $env:PATH $priorPath
        $diagnostic = Get-ChildItem -LiteralPath $LogDir -Filter '*.startup.log' | Sort-Object Name | Select-Object -Last 1 | Get-Content -Raw
        if ($diagnostic -notmatch "result=$($case.Reason);" -or $diagnostic -notmatch "health=$($case.Health);") { throw "Missing diagnostics for $($case.Name): $diagnostic" }
        if ($case.Reason -eq 'healthy') {
            Check ([bool]$failure) $false
            Check (Read-Record).bridge.pid 123
            Check $script:stopped.Count 0
            if ($case.Name -eq 'slow-success') { Check $script:elapsed 12000 }
        } else {
            if (-not $failure -or $failure.ToString() -notmatch $case.Reason) { throw "Wrong failure for $($case.Name): $failure" }
            Check (Get-Content -LiteralPath $pidPath -Raw) $oldRecord
            Check $script:stopped.Count $(if ($case.Exit) { 0 } else { 1 })
            if (-not $case.Exit) { Check $script:stopped[0] 123; Check $script:elapsed 30000 }
            if ($case.Exit -and $script:elapsed -gt 500) { throw 'Early exit waited for timeout' }
            if ($case.Exit -and $diagnostic -notmatch 'exitCode=17;') { throw 'Missing exit code' }
        }
        if ($case.Health -eq 'not-checked') { Check $script:healthCalls 0 }
    }
    Write-Host 'PASS: parsing, configuration, identity, managed actions and 9 startup/rollback scenarios (offline).'
    # Log cleanup: real files/native handles only in this uniquely named fixture.
    # No real process discovery, health requests, launches or stops are permitted.
    function Start-Process { throw 'Cleanup must not start services' }
    function Stop-Process { throw 'Cleanup must not stop services' }
    function Test-Health { throw 'Cleanup must not probe health' }
    function Get-CimInstance {
        param($ClassName,$Filter,$ErrorAction)
        if ($script:cimFails) { throw 'simulated CIM access failure' }
        if ($Filter) { return $script:cleanupProcesses | Where-Object { "ProcessId=$($_.ProcessId)" -eq $Filter } }
        return $script:cleanupProcesses
    }
    $script:cimFails = $false
    $bridgeProcess = [pscustomobject]@{ ProcessId=123; Name='node.exe'; CommandLine='node reverse-runtime.mjs'; CreationDate=$started }
    $tunnelProcess = [pscustomobject]@{ ProcessId=456; Name='tunnel-client.exe'; CommandLine='tunnel-client.exe run'; CreationDate=$started }
    $LogDir = Join-Path $fixture 'cleanup-logs'
    New-Item -ItemType Directory -Path $LogDir | Out-Null
    $LogRetentionDays = 7
    function New-TestLog([string]$name,[int]$age=10) {
        $p = Join-Path $LogDir $name
        [IO.File]::WriteAllText($p,'')
        (Get-Item -LiteralPath $p).LastWriteTime = (Get-Date).AddDays(-$age)
        return $p
    }
    $activeLogs = @{
        bridgeOut=(New-TestLog 'bridge-active-out.log'); bridgeErr=(New-TestLog 'bridge-active-err.log')
        tunnelOut=(New-TestLog 'tunnel-active-out.log'); tunnelErr=(New-TestLog 'tunnel-active-err.log')
    }
    $cleanupRecord = @{ version=2; configPath=$ConfigPath; bridge=$entry; tunnel=@{pid=456;startedUtc=$started.ToString('o')}; logs=$activeLogs }
    Write-Record $cleanupRecord
    $script:cleanupProcesses = @($bridgeProcess,$tunnelProcess)
    $oldBridge = New-TestLog 'bridge-old-out.log'
    $oldTunnel = New-TestLog 'tunnel-old-err.log'
    $recent = New-TestLog 'bridge-recent-out.log' 1
    $other = New-TestLog 'unrelated.log'
    $diagnosticLog = New-TestLog 'bridge-old-out.log.startup.log'
    $nested = Join-Path $LogDir 'nested'
    New-Item -ItemType Directory -Path $nested | Out-Null
    $nestedLog = Join-Path $nested 'bridge-old-out.log'
    [IO.File]::WriteAllText($nestedLog,'')
    (Get-Item -LiteralPath $nestedLog).LastWriteTime = (Get-Date).AddDays(-10)
    # Junctions to an outside (still fixture-owned) directory must not be traversed.
    $outside = Join-Path $fixture 'outside-logs'
    New-Item -ItemType Directory -Path $outside | Out-Null
    $outsideFile = Join-Path $outside 'bridge-external-out.log'
    [IO.File]::WriteAllText($outsideFile,'')
    (Get-Item -LiteralPath $outsideFile).LastWriteTime = (Get-Date).AddDays(-10)
    $junction = Join-Path $LogDir 'bridge-junction-out.log'
    New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
    $hardLink = Join-Path $LogDir 'bridge-hardlink-out.log'
    New-Item -ItemType HardLink -Path $hardLink -Target $outsideFile | Out-Null
    $symbolic = Join-Path $LogDir 'bridge-symbolic-out.log'
    $hasSymbolic = $false
    try { New-Item -ItemType SymbolicLink -Path $symbolic -Target $outsideFile -ErrorAction Stop | Out-Null; $hasSymbolic = $true }
    catch { Write-Host 'SKIP: real file symlink creation unavailable; junction and mocked reparse tests still run.' }
    $recordBefore = Get-Content -LiteralPath $pidPath -Raw
    $DryRun = $true
    $fileBefore = @(Get-ChildItem -LiteralPath $LogDir -Force | ForEach-Object { "$($_.Name)|$($_.LastWriteTimeUtc.Ticks)|$($_.Attributes)" }) -join "`n"
    $preview = Remove-ControllerLogs
    Check $preview.Deleted 0; Check $preview.WouldDelete 2; Check $preview.Eligible 2; Check $preview.Protected 4; Check $preview.Failed 0
    Check ((@(Get-ChildItem -LiteralPath $LogDir -Force | ForEach-Object { "$($_.Name)|$($_.LastWriteTimeUtc.Ticks)|$($_.Attributes)" })) -join "`n") $fileBefore
    $All = $true
    $allAgesPreview = Remove-ControllerLogs
    Check $allAgesPreview.WouldDelete 3; Check $allAgesPreview.Deleted 0; Check $allAgesPreview.Protected 4
    Check ((@(Get-ChildItem -LiteralPath $LogDir -Force | ForEach-Object { "$($_.Name)|$($_.LastWriteTimeUtc.Ticks)|$($_.Attributes)" })) -join "`n") $fileBefore
    $All = $false
    $DryRun = $false
    $cleaned = Remove-ControllerLogs
    Check $cleaned.Deleted 2; Check $cleaned.Protected 4; Check $cleaned.Failed 0
    foreach ($p in @($recent,$other,$diagnosticLog,$nestedLog,$outsideFile) + @($activeLogs.Values)) { Check (Test-Path -LiteralPath $p) $true }
    foreach ($p in @($oldBridge,$oldTunnel)) { Check (Test-Path -LiteralPath $p) $false }
    Check (Get-Content -LiteralPath $pidPath -Raw) $recordBefore
    # Both native switch spellings bind, preview preserves all files, and active logs stay protected.
    foreach ($variant in @('lower','upper')) {
        if ($variant -eq 'lower') { . $controller -Action cleanup-logs -all -DryRun }
        else { . $controller -Action cleanup-logs -ALL -DryRun }
        $LogDir = Join-Path $fixture 'cleanup-logs'
        $allPreview = Remove-ControllerLogs
        Check $allPreview.WouldDelete 1; Check $allPreview.Deleted 0; Check $allPreview.Protected 4
        Check (Test-Path -LiteralPath $recent) $true
    }
    $DryRun = $false
    $allCleaned = Remove-ControllerLogs
    Check $allCleaned.Deleted 1; Check $allCleaned.Protected 4; Check (Test-Path -LiteralPath $recent) $false
    foreach ($p in $activeLogs.Values) { Check (Test-Path -LiteralPath $p) $true }
    $recent = New-TestLog 'bridge-recent-out.log' 1
    $All = $false
    # A linked LogDir or ancestor must fail closed, not enumerate its target.
    $savedLogDir = $LogDir
    $LogDir = $junction
    $unsafe = Remove-ControllerLogs
    Check $unsafe.Deleted 0; Check $unsafe.Failed 1; Check (Test-Path -LiteralPath $outsideFile) $true
    $LogDir = $savedLogDir
    Remove-Item -LiteralPath $junction -Force
    Remove-Item -LiteralPath $hardLink -Force
    if ($hasSymbolic) { Remove-Item -LiteralPath $symbolic -Force }
    # One component alive, both exited, and reused/mismatched identities.
    $candidate = New-TestLog 'tunnel-candidate-out.log'
    $script:cleanupProcesses = @($bridgeProcess)
    $single = Remove-ControllerLogs
    Check $single.Protected 2; Check $single.Deleted 3
    $candidate = New-TestLog 'bridge-candidate-out.log'
    $script:cleanupProcesses = @()
    $inactive = Remove-ControllerLogs
    Check $inactive.Protected 0; Check $inactive.Deleted 3
    $candidate = New-TestLog 'bridge-kept-out.log'
    foreach ($badState in @('missing','corrupt','mismatch','reused','cim-error','unrecorded','missing-log')) {
        Write-Record $cleanupRecord
        $script:cleanupProcesses = @($bridgeProcess,$tunnelProcess)
        $script:cimFails = $false
        switch ($badState) {
            'missing' { Remove-Item -LiteralPath $pidPath }
            'corrupt' { [IO.File]::WriteAllText($pidPath,'{broken') }
            'mismatch' { $script:cleanupProcesses = @([pscustomobject]@{ ProcessId=123;Name='node.exe';CommandLine='other.mjs';CreationDate=$started },$tunnelProcess) }
            'reused' { $script:cleanupProcesses = @([pscustomobject]@{ ProcessId=123;Name='node.exe';CommandLine='reverse-runtime.mjs';CreationDate=$started.AddMinutes(1) },$tunnelProcess) }
            'cim-error' { $script:cimFails = $true }
            'unrecorded' { $script:cleanupProcesses += [pscustomobject]@{ProcessId=999;Name='node.exe';CommandLine='node reverse-runtime.mjs';CreationDate=$started} }
            'missing-log' { $badRecord = $cleanupRecord.Clone(); $badRecord.logs=@{}; Write-Record $badRecord }
        }
        $stateBefore = if (Test-Path -LiteralPath $pidPath) { Get-Content -LiteralPath $pidPath -Raw } else { 'absent' }
        $blocked = Remove-ControllerLogs
        Check $blocked.Deleted 0; Check (Test-Path -LiteralPath $candidate) $true
        Check $(if (Test-Path -LiteralPath $pidPath) { Get-Content -LiteralPath $pidPath -Raw } else { 'absent' }) $stateBefore
    }
    $script:cimFails = $false; $script:cleanupProcesses = @()
    Write-Record $cleanupRecord
    # Locked files report failure while other safe candidates are still removed.
    $locked = New-TestLog 'bridge-locked-out.log'
    $lockHandle = [IO.File]::Open($locked,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        $partial = Remove-ControllerLogs
        Check $partial.Failed 1; Check $partial.Deleted 1; Check $partial.Eligible 2
        Check (Test-Path -LiteralPath $locked) $true
    } finally { $lockHandle.Dispose() }
    # Revalidation: change timestamp, link status, state or remove a file between scans.
    $realProtection = ${function:Get-CleanupProtection}
    foreach ($change in @('fresh','reparse','disappear','active','record-error')) {
        $script:cleanupTarget = $locked
        $script:protectionCalls = 0
        $script:change = $change
        function Get-CleanupProtection {
            $script:protectionCalls++
            if ($script:protectionCalls -eq 2) {
                switch ($script:change) {
                    'fresh' { (Get-Item -LiteralPath $script:cleanupTarget).LastWriteTime = Get-Date }
                    'reparse' {
                        Remove-Item -LiteralPath $script:cleanupTarget
                        New-Item -ItemType Junction -Path $script:cleanupTarget -Target $outside | Out-Null
                    }
                    'disappear' { Remove-Item -LiteralPath $script:cleanupTarget }
                    'active' { return @{ $script:cleanupTarget=$true } }
                    'record-error' { throw 'state changed' }
                }
            }
            return @{}
        }
        $rechecked = Remove-ControllerLogs
        Check $rechecked.Deleted 0
        if ($change -eq 'active') { Check $rechecked.Protected 1 }
        if ($change -eq 'disappear') { Check $rechecked.Failed 1 }
        Check (Test-Path -LiteralPath $outsideFile) $true
        if (Test-Path -LiteralPath $locked) { Remove-Item -LiteralPath $locked -Force }
        $locked = New-TestLog 'bridge-locked-out.log'
    }
    ${function:Get-CleanupProtection} = $realProtection
    # Dispatch uses the same cleanup path. Dry run also protects stopped state.
    $Action = 'cleanup-logs'; $DryRun = $true
    & $runAction
    Check (Test-Path -LiteralPath $locked) $true
    Write-Host 'PASS: log cleanup retention, active protection, dry run, links, untrusted state, failures and revalidation (offline).'
} finally {
    Set-Location $location
    # Only remove this test's uniquely named temporary fixture.
    if ((Split-Path ([IO.Path]::GetFullPath($fixture)) -Parent) -eq $fixtureParent -and (Split-Path $fixture -Leaf) -like 'bridge-controller-*') {
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
