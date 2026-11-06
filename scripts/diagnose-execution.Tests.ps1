#requires -Version 5.1
# Run in an operator shell whose existing policy permits local scripts.
# Never changes execution policy. Uses only disposable files; executes no Python/Codex.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path $PSScriptRoot -Parent
$parent = Join-Path $repo 'plugins\transceiver\tests'
$fixture = Join-Path $parent ('.diagnostics-' + [guid]::NewGuid())
function Check($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected [$Expected], got [$Actual]" }
}
function Write-Utf8([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}
$oldPath = $env:PATH
try {
    $scripts = Join-Path $fixture 'scripts'
    $project = Join-Path $fixture 'project'
    $other = Join-Path $fixture 'project-other'
    $bin = Join-Path $fixture 'bin'
    $venv = Join-Path $fixture 'venv'
    $runtime = Join-Path $fixture 'runtime\control'
    $sourceDir = Join-Path $fixture 'plugins\transceiver\scripts'
    New-Item -ItemType Directory -Path $scripts,$project,$other,$bin,$runtime,$sourceDir,(Join-Path $venv 'Scripts') -Force | Out-Null
    $diagnostic = Join-Path $scripts 'diagnose-execution.ps1'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'diagnose-execution.ps1') -Destination $diagnostic
    Copy-Item -LiteralPath (Join-Path $repo 'plugins\transceiver\scripts\reverse-runtime.mjs') -Destination $sourceDir
    # Invalid executables ensure any accidental execution fails this suite.
    foreach ($exe in @('python.exe','uv.exe','codex.exe')) { Write-Utf8 (Join-Path $bin $exe) 'NOT AN EXECUTABLE' }
    Write-Utf8 (Join-Path $venv 'Scripts\python.exe') 'NOT AN EXECUTABLE'
    $env:PATH = $bin
    $policyPath = Join-Path $fixture 'config.json'
    $entry = @{ name='demo'; sync=$true; allowCodexTasks=$true; chatgptUrl='SECRET_URL_MUST_NOT_APPEAR' }
    function Save-Policy {
        @{ version=1; projects=@{ $project=$entry } } | ConvertTo-Json -Depth 5 | ForEach-Object { Write-Utf8 $policyPath $_ }
    }
    Save-Policy
    Write-Utf8 (Join-Path $runtime 'processes.json') (@{ codexExe=(Join-Path $bin 'codex.exe'); token='SECRET_RECORD_MUST_NOT_APPEAR' } | ConvertTo-Json)
    $envPath=Join-Path $fixture 'bridge.env'
    function Save-Env([string]$Strategy='adaptive', [string]$Allow='1') {
        Write-Utf8 $envPath ("TUNNEL_PROFILE=SECRET_PROFILE_MUST_NOT_APPEAR`nCODEX_BIN=`"$bin`"`n" +
            "CODEX_MCP_BRIDGE_DEFAULT_SANDBOX=read-only`nCODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY=$Strategy`n" +
            "CODEX_MCP_BRIDGE_ALLOW_WRITE=$Allow`nCODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS=0`n")
    }
    Save-Env
    Write-Utf8 (Join-Path $venv 'pyvenv.cfg') ("home = $bin`nbase-executable = $bin\python.exe`ncommand = SECRET_COMMAND_MUST_NOT_APPEAR`n")
    $before=@{}
    Get-ChildItem -LiteralPath $fixture -File -Recurse | ForEach-Object { $before[$_.FullName]=(Get-FileHash -LiteralPath $_.FullName).Hash }
    $r=& $diagnostic -AsObject -Project demo -Cwd $project -RequestedSandbox workspace-write -CheckPython -VenvPath $venv
    Check $r.repositoryApprovalPolicy.value 'never'
    Check $r.repositoryApprovalPolicy.status 'observed-source'
    if ($r.repositoryApprovalPolicy.line -lt 1) { throw 'Missing policy source line' }
    Check $r.controllerConfiguration.accessStrategy.value 'adaptive'
    Check $r.controllerConfiguration.sandboxCandidate.value 'workspace-write'
    Check $r.controllerConfiguration.sandboxCandidate.permittedByConfiguredLimits $true
    Check $r.appServerActual.status 'unknown-not-queried'
    Check $r.savedStrategy.status 'unknown-not-queried'
    Check $r.projectAuthorization.status 'configured-candidate'
    Check $r.projectAuthorization.authoritative $false
    Check $r.codexExecutables.controllerUsesPathFallback $false
    Check $r.codexExecutables.recorded.fileReadable $true
    Check $r.pythonChecks.python.observation.executionAccess 'unknown-not-executed'
    Check $r.pythonChecks.venv.baseReferences.Count 2
    Check $r.pythonChecks.venv.baseReferences[0].observation.fileReadable $true
    $json=$r | ConvertTo-Json -Depth 12
    if ($json -match 'SECRET_') { throw 'Diagnostic leaked a non-whitelisted value' }
    Get-ChildItem -LiteralPath $fixture -File -Recurse | ForEach-Object {
        if (-not $before.ContainsKey($_.FullName)) { throw 'Diagnostic created a file' }
        Check (Get-FileHash -LiteralPath $_.FullName).Hash $before[$_.FullName]
    }
    # A sibling with a shared prefix is outside the project; no implicit cwd switch.
    $r=& $diagnostic -AsObject -Project demo -Cwd $other
    Check $r.projectAuthorization.status 'not-eligible'
    Write-Utf8 (Join-Path $project 'not-a-directory.txt') 'fixture'
    $r=& $diagnostic -AsObject -Project demo -Cwd (Join-Path $project 'not-a-directory.txt')
    Check $r.projectAuthorization.status 'not-eligible'
    $entry.allowCodexTasks=$false; Save-Policy
    $r=& $diagnostic -AsObject -Project demo -Cwd $project
    Check $r.projectAuthorization.status 'not-eligible'
    $entry.allowCodexTasks='True'; Save-Policy
    $r=& $diagnostic -AsObject -Project demo -Cwd $project
    Check $r.projectAuthorization.status 'not-eligible'
    Save-Env 'read-only'
    $r=& $diagnostic -AsObject -RequestedSandbox workspace-write
    Check $r.controllerConfiguration.sandboxCandidate.value 'read-only'
    Save-Env 'always-full'
    $r=& $diagnostic -AsObject
    Check $r.controllerConfiguration.sandboxCandidate.permittedByConfiguredLimits $false
    Save-Env 'adaptive' '0'
    $r=& $diagnostic -AsObject -RequestedSandbox workspace-write
    Check $r.controllerConfiguration.sandboxCandidate.permittedByConfiguredLimits $false
    # Arbitrary values and unsupported keys are not returned as error diagnostics.
    Save-Env 'SECRET_BAD_STRATEGY'
    $r=& $diagnostic -AsObject
    Check $r.controllerConfiguration.accessStrategy.valid $false
    if (($r | ConvertTo-Json -Depth 12) -match 'SECRET_') { throw 'Invalid enum value leaked' }
    Write-Utf8 $envPath 'UNKNOWN_SECRET=SECRET_UNKNOWN'
    $r=& $diagnostic -AsObject
    Check $r.controllerConfiguration.envStatus 'unsupported-or-duplicate-key'
    Check $r.controllerConfiguration.sandboxCandidate.permittedByConfiguredLimits $false
    Write-Utf8 $policyPath ('x' * 262145)
    Save-Env
    $r=& $diagnostic -AsObject -Project demo -PythonPath (Join-Path $fixture 'missing.exe')
    Check $r.projectAuthorization.status 'too-large'
    Check $r.pythonChecks.python.observation.status 'missing-or-inaccessible'
    Write-Output 'PASS: offline execution diagnostic fixture checks'
} finally {
    $env:PATH=$oldPath
    if ((Split-Path $fixture -Parent) -cne $parent -or (Split-Path $fixture -Leaf) -notlike '.diagnostics-*') { throw 'Unsafe fixture cleanup target' }
    if (Test-Path -LiteralPath $fixture) {
        $item=Get-Item -LiteralPath $fixture -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refuse linked fixture cleanup' }
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
