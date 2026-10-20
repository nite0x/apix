$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$apixHeaders = @{ Accept = 'application/json, text/event-stream' }
function Invoke-ApixConnectionRPC($payload) {
    $body = $payload | ConvertTo-Json -Depth 10 -Compress
    $response = Invoke-WebRequest -UseBasicParsing -Uri $apixEndpoint -Method Post -Headers $apixHeaders -ContentType 'application/json' -Body $body -TimeoutSec 6 -MaximumRedirection 0
    if ($response.Headers['Mcp-Session-Id']) { $apixHeaders['Mcp-Session-Id'] = $response.Headers['Mcp-Session-Id'] }
    $content = [string]$response.Content
    if ([string]::IsNullOrWhiteSpace($content)) { return $null }
    if ($content.TrimStart().StartsWith('{')) { $message = $content | ConvertFrom-Json }
    else {
        $message = $null
        foreach ($line in ($content -split "`n")) {
            if ($line.StartsWith('data:')) {
                $candidate = $line.Substring(5).Trim() | ConvertFrom-Json
                if ($candidate.id -eq $payload.id) { $message = $candidate; break }
            }
        }
    }
    if ($null -eq $message -or $message.id -ne $payload.id -or $message.error) { throw 'Invalid MCP response' }
    return $message.result
}
$stage = 'handshake'
try {
    $init = Invoke-ApixConnectionRPC @{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{ protocolVersion = '2025-03-26'; capabilities = @{}; clientInfo = @{ name = 'apix-workbench-windows-test'; version = '1.0.0' } } }
    if (-not $init.serverInfo.name -or -not $init.protocolVersion) { throw 'Invalid initialization' }
    $apixHeaders['MCP-Protocol-Version'] = $init.protocolVersion
    $null = Invoke-ApixConnectionRPC @{ jsonrpc = '2.0'; method = 'notifications/initialized'; params = @{} }
    $stage = 'tools'
    $names = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    $cursors = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    $cursor = $null
    for ($page = 0; $page -lt 100; $page++) {
        $params = @{}
        if ($cursor) { $params.cursor = $cursor }
        $tools = Invoke-ApixConnectionRPC @{ jsonrpc = '2.0'; id = (2 + $page); method = 'tools/list'; params = $params }
        if (-not ($tools.PSObject.Properties.Name -contains 'tools')) { throw 'Missing tools' }
        foreach ($tool in $tools.tools) {
            if (-not $tool.name) { throw 'Invalid tool' }
            $null = $names.Add([string]$tool.name)
        }
        $cursor = $tools.nextCursor
        if (-not $cursor) {
            @{ server_name = $init.serverInfo.name; tools_count = $names.Count } | ConvertTo-Json -Compress
            exit 0
        }
        if (-not $cursors.Add($cursor)) { throw 'Repeated cursor' }
    }
    throw 'Too many pages'
} catch {
    @{ error = $stage } | ConvertTo-Json -Compress
    exit 0
}
