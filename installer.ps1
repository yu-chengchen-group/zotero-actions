$ErrorActionPreference = "Stop"

function Zh([string]$Base64) {
    return [Text.Encoding]::UTF8.GetString(
        [Convert]::FromBase64String($Base64)
    )
}

function Fail([string]$Message) {
    Write-Host $Message -ForegroundColor Red
    exit 1
}

function Test-MemberKey([string]$Key) {
    if ([string]::IsNullOrWhiteSpace($Key)) {
        return $false
    }
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
        Fail (Zh "5peg5rOV6aqM6K+B6K++6aKY57uEIEFQSSBLZXnvvIzor7fmo4Dmn6XnvZHnu5zlkI7ph43or5XjgII=")
    }
}

$zoteroWasRunning = $false
$zoteroPath = $null
$zoteroProcesses = @(Get-Process zotero -ErrorAction SilentlyContinue)
if ($zoteroProcesses.Count -gt 0) {
    $zoteroWasRunning = $true
    $pathProcess = $zoteroProcesses |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_.Path) } |
        Select-Object -First 1
    if (-not $pathProcess) {
        Fail (Zh "5peg5rOV6I635Y+WIFpvdGVybyDov5DooYzot6/lvoTvvIzor7fmiYvliqjlhbPpl63lkI7ph43or5XjgII=")
    }
    $zoteroPath = $pathProcess.Path

    foreach ($process in $zoteroProcesses) {
        if ($process.MainWindowHandle -ne 0) {
            [void]$process.CloseMainWindow()
        }
    }

    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Process zotero -ErrorAction SilentlyContinue) -and
        (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if (Get-Process zotero -ErrorAction SilentlyContinue) {
        Fail (Zh "5peg5rOV6Ieq5Yqo5YWz6ZetIFpvdGVyb++8jOivt+aJi+WKqOWFs+mXreWQjumHjeivleOAgg==")
    }
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptsDir = Join-Path $root "scripts"
$scriptFiles = @(
    "sync-attachments.js",
    "document2md.js"
)
foreach ($name in $scriptFiles) {
    if (-not (Test-Path (Join-Path $scriptsDir $name))) {
        Fail ((Zh "57y65bCRIHNjcmlwdHNcezB977yM6K+36YeN5paw5LiL6L295bm25a6M5pW06Kej5Y6L44CC") -f $name)
    }
}

$zoteroRoot = Join-Path $env:APPDATA "Zotero\Zotero"
$profilesIni = Join-Path $zoteroRoot "profiles.ini"
if (-not (Test-Path $profilesIni)) {
    Fail (Zh "5pyq5om+5YiwIFpvdGVybyDphY3nva7vvIzor7flhYjlkK/liqjkuIDmrKEgWm90ZXJv44CC")
}

$profiles = @()
$current = $null
foreach ($rawLine in [IO.File]::ReadAllLines($profilesIni)) {
    $line = $rawLine.Trim()
    if ($line -match '^\[Profile\d+\]$') {
        if ($current) {
            $profiles += [pscustomobject]$current
        }
        $current = @{}
        continue
    }
    if ($current -and $line -match '^([^=]+)=(.*)$') {
        $current[$matches[1]] = $matches[2]
    }
}
if ($current) {
    $profiles += [pscustomobject]$current
}

$profile = $profiles | Where-Object { $_.Default -eq "1" } | Select-Object -First 1
if (-not $profile -and $profiles.Count -eq 1) {
    $profile = $profiles[0]
}
if (-not $profile) {
    Fail (Zh "5peg5rOV56Gu5a6a6buY6K6kIFpvdGVybyDphY3nva7mlofku7bjgII=")
}

$profilePath = if ($profile.IsRelative -eq "1") {
    Join-Path $zoteroRoot ($profile.Path -replace '/', '\')
}
else {
    $profile.Path
}
$prefsPath = Join-Path $profilePath "prefs.js"
if (-not (Test-Path $prefsPath)) {
    Fail (Zh "5pyq5om+5YiwIFpvdGVybyBwcmVmcy5qc+OAgg==")
}

$pluginXpi = Join-Path $profilePath "extensions\zoterotag@euclpts.com.xpi"
$pluginDir = Join-Path $profilePath "extensions\zoterotag@euclpts.com"
if (-not (Test-Path $pluginXpi) -and -not (Test-Path $pluginDir)) {
    Fail (Zh "5pyq5a6J6KOFIFpvdGVybyBBY3Rpb25zICYgVGFncyDmj5Lku7bjgII=")
}

$apiKey = [Environment]::GetEnvironmentVariable(
    "CHEN_GROUP_API_KEY_MEMBER",
    [EnvironmentVariableTarget]::User
)
if (-not (Test-MemberKey $apiKey)) {
    $secureKey = Read-Host (Zh "6K+36L6T5YWl6K++6aKY57uEIEFQSSBLZXk=") -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try {
        $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
        Fail (Zh "QVBJIEtleSDkuI3og73kuLrnqbrjgII=")
    }
    if (-not (Test-MemberKey $apiKey)) {
        Fail (Zh "QVBJIEtleSDml6DmlYjvvIzor7fph43mlrDovpPlhaXjgII=")
    }
}

$syncMenu = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String("5ZCM5q2l6ZmE5Lu2")
)

$hiddenMenu = [ordered]@{
    item = $false
    collection = $false
    tools = $false
    reader = $false
    readerAnnotation = $false
}
$visibleMenu = [ordered]@{
    item = $true
    collection = $true
    tools = $false
    reader = $false
    readerAnnotation = $false
}

$actions = @(
    [pscustomobject]@{
        key = "1786529156738-JlgQvNK5"
        name = "document2md"
        menu = "document2md"
        showInMenu = $hiddenMenu
        file = "document2md.js"
    },
    [pscustomobject]@{
        key = "sync-attachments"
        name = $syncMenu
        menu = $syncMenu
        showInMenu = $visibleMenu
        file = "sync-attachments.js"
    }
)

$backupPath = "$prefsPath.zotero-actions.bak"
Copy-Item $prefsPath $backupPath -Force

$lines = [Collections.Generic.List[string]]::new()
foreach ($line in [IO.File]::ReadAllLines($prefsPath)) {
    [void]$lines.Add($line)
}

foreach ($definition in $actions) {
    $data = [IO.File]::ReadAllText(
        (Join-Path $scriptsDir $definition.file),
        [Text.Encoding]::UTF8
    )
    $action = [ordered]@{
        event = 0
        operation = 4
        data = $data
        shortcut = ""
        enabled = $true
        menu = $definition.menu
        name = $definition.name
        showInMenu = $definition.showInMenu
    }
    $actionJson = ConvertTo-Json -InputObject $action -Depth 10 -Compress
    $prefValue = ConvertTo-Json -InputObject $actionJson -Compress
    $prefName = "extensions.actionsTags.rules.$($definition.key)"
    $prefix = 'user_pref("' + $prefName + '", '
    $newLine = $prefix + $prefValue + ');'

    $matches = @()
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index].StartsWith($prefix)) {
            $matches += $index
        }
    }
    if ($matches.Count -gt 1) {
        Fail ((Zh "cHJlZnMuanMg5Lit5a2Y5Zyo6YeN5aSN5Yqo5L2c77yaezB9") -f $definition.key)
    }
    if ($matches.Count -eq 1) {
        $lines[$matches[0]] = $newLine
    }
    else {
        [void]$lines.Add($newLine)
    }
}

$rulesPrefName = "extensions.actionsTags.rules"
$rulesPrefix = 'user_pref("' + $rulesPrefName + '", '
$rulesMatches = @()
for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index].StartsWith($rulesPrefix)) {
        $rulesMatches += $index
    }
}
if ($rulesMatches.Count -gt 1) {
    Fail (Zh "cHJlZnMuanMg5Lit5a2Y5Zyo6YeN5aSN55qEIEFjdGlvbnMgJiBUYWdzIOWKqOS9nOe0ouW8leOAgg==")
}

$ruleKeys = @()
if ($rulesMatches.Count -eq 1) {
    try {
        $rawValue = $lines[$rulesMatches[0]].Substring($rulesPrefix.Length)
        if (-not $rawValue.EndsWith(");")) {
            throw "invalid"
        }
        $rawValue = $rawValue.Substring(0, $rawValue.Length - 2)
        $rulesJson = ConvertFrom-Json -InputObject $rawValue
        $ruleKeys = @((ConvertFrom-Json -InputObject $rulesJson))
    }
    catch {
        Fail (Zh "cHJlZnMuanMg5Lit55qEIEFjdGlvbnMgJiBUYWdzIOWKqOS9nOe0ouW8leagvOW8j+aXoOaViOOAgg==")
    }
}

foreach ($definition in $actions) {
    if ($definition.key -notin $ruleKeys) {
        $ruleKeys += $definition.key
    }
}
$rulesJson = ConvertTo-Json -InputObject @($ruleKeys) -Compress
$rulesValue = ConvertTo-Json -InputObject $rulesJson -Compress
$rulesLine = $rulesPrefix + $rulesValue + ');'
if ($rulesMatches.Count -eq 1) {
    $lines[$rulesMatches[0]] = $rulesLine
}
else {
    [void]$lines.Add($rulesLine)
}

$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllLines($prefsPath, $lines, $utf8)

[string[]]$writtenLines = [IO.File]::ReadAllLines($prefsPath)
$writtenRules = @($writtenLines | Where-Object { $_.StartsWith($rulesPrefix) })
if ($writtenRules.Count -ne 1) {
    Fail ((Zh "5a6J6KOF5qCh6aqM5aSx6LSl77ya5Yqo5L2c57Si5byV5pyq5YyF5ZCrIHswfeOAgg==") -f $rulesPrefName)
}
try {
    $rawValue = $writtenRules[0].Substring($rulesPrefix.Length)
    $rawValue = $rawValue.Substring(0, $rawValue.Length - 2)
    $writtenRulesJson = ConvertFrom-Json -InputObject $rawValue
    $writtenRuleKeys = @((ConvertFrom-Json -InputObject $writtenRulesJson))
}
catch {
    Fail (Zh "cHJlZnMuanMg5Lit55qEIEFjdGlvbnMgJiBUYWdzIOWKqOS9nOe0ouW8leagvOW8j+aXoOaViOOAgg==")
}
foreach ($definition in $actions) {
    if ($definition.key -notin $writtenRuleKeys) {
        Fail ((Zh "5a6J6KOF5qCh6aqM5aSx6LSl77ya5Yqo5L2c57Si5byV5pyq5YyF5ZCrIHswfeOAgg==") -f $definition.key)
    }
    $prefName = "extensions.actionsTags.rules.$($definition.key)"
    $prefix = 'user_pref("' + $prefName + '", '
    if (@($writtenLines | Where-Object { $_.StartsWith($prefix) }).Count -ne 1) {
        Fail ((Zh "5a6J6KOF5qCh6aqM5aSx6LSl77ya5pyq5q2j56Gu5YaZ5YWl5Yqo5L2cIHswfeOAgg==") -f $definition.key)
    }
}

[Environment]::SetEnvironmentVariable(
    "CHEN_GROUP_API_KEY_MEMBER",
    $apiKey,
    [EnvironmentVariableTarget]::User
)
$env:CHEN_GROUP_API_KEY_MEMBER = $apiKey

if ([Environment]::GetEnvironmentVariable(
    "CHEN_GROUP_API_KEY_MEMBER",
    [EnvironmentVariableTarget]::User
) -ne $apiKey) {
    Fail (Zh "5a6J6KOF5qCh6aqM5aSx6LSl77ya6K++6aKY57uEIEFQSSBLZXkg5pyq5q2j56Gu5YaZ5YWl55So5oi3546v5aKD5Y+Y6YeP44CC")
}

if ($zoteroWasRunning) {
    try {
        Start-Process -FilePath $zoteroPath
    }
    catch {
        Fail (Zh "5a6J6KOF5a6M5oiQ77yM5L2GIFpvdGVybyDoh6rliqjlkK/liqjlpLHotKXvvIzor7fmiYvliqjlkK/liqjjgII=")
    }
}
Write-Host (Zh "5a6J6KOF5a6M5oiQ44CC5Y+v5ZyoIFpvdGVyb+KAnOaIkeeahOaWh+W6k+KAneS4reS9v+eUqOKAnOWQjOatpemZhOS7tuKAneOAgg==") -ForegroundColor Green

