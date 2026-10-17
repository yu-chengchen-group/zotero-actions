param(
    [ValidateSet("doctor", "uninstall")]
    [string]$Action
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
    Write-Host $Message -ForegroundColor Red
    exit 1
}

function Get-ZoteroProfilePath {
    $zoteroRoot = Join-Path $env:APPDATA "Zotero\Zotero"
    $profilesIni = Join-Path $zoteroRoot "profiles.ini"
    if (-not (Test-Path $profilesIni)) {
        Fail "Zotero profile configuration was not found. Start Zotero once and retry."
    }

    $profiles = @()
    $current = $null
    foreach ($rawLine in [IO.File]::ReadAllLines($profilesIni)) {
        $line = $rawLine.Trim()
        if ($line -match '^\[Profile\d+\]$') {
            if ($current) { $profiles += [pscustomobject]$current }
            $current = @{}
            continue
        }
        if ($current -and $line -match '^([^=]+)=(.*)$') {
            $current[$matches[1]] = $matches[2]
        }
    }
    if ($current) { $profiles += [pscustomobject]$current }

    $profile = $profiles | Where-Object { $_.Default -eq "1" } | Select-Object -First 1
    if (-not $profile -and $profiles.Count -eq 1) { $profile = $profiles[0] }
    if (-not $profile) { Fail "Could not determine the default Zotero profile." }

    if ($profile.IsRelative -eq "1") {
        return Join-Path $zoteroRoot ($profile.Path -replace '/', '\')
    }
    return $profile.Path
}

function Get-PrefsPath {
    $prefsPath = Join-Path (Get-ZoteroProfilePath) "prefs.js"
    if (-not (Test-Path $prefsPath)) { Fail "Zotero prefs.js was not found." }
    return $prefsPath
}

function Test-MemberKey([string]$Key) {
    if ([string]::IsNullOrWhiteSpace($Key)) { return $false }
    try {
        $response = Invoke-WebRequest -UseBasicParsing `
            -Uri "https://api.chen-group.cn/v1/attachments?doi=10.5555/zotero-actions-key-check&cache_only=1" `
            -Headers @{ Authorization = "Bearer $Key" } `
            -TimeoutSec 15
        return ([int]$response.StatusCode -ne 401)
    }
    catch {
        if ($_.Exception.Response) {
            return ([int]$_.Exception.Response.StatusCode.value__ -ne 401)
        }
        return $false
    }
}

$actionKeys = @("1786529156738-JlgQvNK5", "sync-attachments")
$prefsPath = Get-PrefsPath
$lines = [Collections.Generic.List[string]]::new()
foreach ($line in [IO.File]::ReadAllLines($prefsPath)) { [void]$lines.Add($line) }

if ($Action -eq "doctor") {
    $profilePath = Split-Path -Parent $prefsPath
    $pluginXpi = Join-Path $profilePath "extensions\zoterotag@euclpts.com.xpi"
    $pluginDir = Join-Path $profilePath "extensions\zoterotag@euclpts.com"
    if (-not (Test-Path $pluginXpi) -and -not (Test-Path $pluginDir)) {
        Fail "Zotero Actions & Tags is not installed."
    }

    foreach ($key in $actionKeys) {
        $prefix = 'user_pref("extensions.actionsTags.rules.' + $key + '", '
        if (@($lines | Where-Object { $_.StartsWith($prefix) }).Count -ne 1) {
            Fail "Required action is missing or duplicated: $key"
        }
    }

    $apiKey = [Environment]::GetEnvironmentVariable(
        "CHEN_GROUP_API_KEY_MEMBER",
        [EnvironmentVariableTarget]::User
    )
    if (-not (Test-MemberKey $apiKey)) {
        Fail "CHEN_GROUP_API_KEY_MEMBER is missing, invalid, or the attachment service is unreachable."
    }

    Write-Host "Zotero Actions check passed." -ForegroundColor Green
    exit 0
}

if (Get-Process zotero -ErrorAction SilentlyContinue) {
    Fail "Close Zotero before uninstalling Zotero Actions."
}

$backupPath = "$prefsPath.zotero-actions-uninstall.bak"
Copy-Item $prefsPath $backupPath -Force

foreach ($key in $actionKeys) {
    $prefix = 'user_pref("extensions.actionsTags.rules.' + $key + '", '
    for ($index = $lines.Count - 1; $index -ge 0; $index--) {
        if ($lines[$index].StartsWith($prefix)) { $lines.RemoveAt($index) }
    }
}

$rulesPrefix = 'user_pref("extensions.actionsTags.rules", '
$rulesMatches = @()
for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index].StartsWith($rulesPrefix)) { $rulesMatches += $index }
}
if ($rulesMatches.Count -gt 1) { Fail "Actions & Tags rule index is duplicated in prefs.js." }
if ($rulesMatches.Count -eq 1) {
    try {
        $rawValue = $lines[$rulesMatches[0]].Substring($rulesPrefix.Length)
        if (-not $rawValue.EndsWith(");")) { throw "invalid" }
        $rawValue = $rawValue.Substring(0, $rawValue.Length - 2)
        $rulesJson = ConvertFrom-Json -InputObject $rawValue
        $ruleKeys = @((ConvertFrom-Json -InputObject $rulesJson)) | Where-Object { $_ -notin $actionKeys }
        $newRulesJson = ConvertTo-Json -InputObject @($ruleKeys) -Compress
        $newRulesValue = ConvertTo-Json -InputObject $newRulesJson -Compress
        $lines[$rulesMatches[0]] = $rulesPrefix + $newRulesValue + ');'
    }
    catch {
        Fail "Actions & Tags rule index in prefs.js is invalid."
    }
}

$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllLines($prefsPath, $lines, $utf8)
[Environment]::SetEnvironmentVariable(
    "CHEN_GROUP_API_KEY_MEMBER",
    $null,
    [EnvironmentVariableTarget]::User
)
Write-Host "Zotero Actions removed. Zotero Actions & Tags itself was kept." -ForegroundColor Green
