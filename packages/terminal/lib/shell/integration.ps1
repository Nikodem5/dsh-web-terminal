# dsh-web-terminal shell integration for PowerShell 5.1 and 7 (loaded after the user's profile).
#
# Emits invisible OSC sequences so the web UI can split the session into command blocks:
#   133;A prompt start, 133;B prompt end, 133;C output start, 133;D;<exit> command finished,
#   633;E;<command line> the accepted command, 633;P;Cwd=<folder> the real current folder.
# Nothing is printed and the profile's own prompt (oh-my-posh, starship, ...) is wrapped, not replaced.

if ($global:__dshWtIntegration) { return }
if ($Host.Name -ne 'ConsoleHost') { return }
$global:__dshWtIntegration = $true

$global:__dshWt = @{
    Ran         = $false
    OrigPrompt  = $null
    OrigReadLine = $null
    LastErr     = $null
}

# VS Code's escaping: backslash, ';' and control characters become \\ and \xNN so a value never ends the OSC early.
function global:__dshWt_Esc([string]$Value) {
    $s = $Value.Replace('\', '\\').Replace(';', '\x3b')
    [regex]::Replace($s, '[\x00-\x1f\x7f]', { param($m) '\x{0:x2}' -f [int][char]$m.Value })
}

function global:__dshWt_Osc([string]$Body) {
    "$([char]27)]$Body$([char]7)"
}

# What the profile (or PowerShell itself) uses as the prompt.
$global:__dshWt.OrigPrompt = $function:prompt
if ($null -eq $global:__dshWt.OrigPrompt) {
    $global:__dshWt.OrigPrompt = { "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) " }
}

function global:prompt {
    # Capture the previous command's outcome before anything here changes it.
    $ok = $global:?
    $lastExit = $global:LASTEXITCODE
    $err = if ($Error.Count -gt 0) { $Error[0] } else { $null }
    $text = ''
    try {
        $esc = ''
        if ($global:__dshWt.Ran) {
            $global:__dshWt.Ran = $false
            $code = 0
            # A PowerShell error (new $Error[0]) is 1; otherwise the native program's code, which $LASTEXITCODE keeps from earlier commands.
            if (-not $ok) { $code = if ($lastExit -is [int] -and $lastExit -ne 0 -and [object]::ReferenceEquals($err, $global:__dshWt.LastErr)) { $lastExit } else { 1 } }
            $esc += __dshWt_Osc "133;D;$code"
        }
        $loc = $executionContext.SessionState.Path.CurrentLocation
        if ($loc.Provider.Name -eq 'FileSystem') { $esc += __dshWt_Osc "633;P;Cwd=$(__dshWt_Esc $loc.ProviderPath)" }
        $esc += __dshWt_Osc '133;A'
        $Host.UI.Write($esc)
    } catch {}
    # The original prompt must see the same $? and $LASTEXITCODE the user's command left.
    $global:LASTEXITCODE = $lastExit
    if (-not $ok) { Write-Error 'dsh' -ErrorAction Ignore }
    $text = & $global:__dshWt.OrigPrompt
    $global:LASTEXITCODE = $lastExit
    $global:__dshWt.LastErr = if ($Error.Count -gt 0) { $Error[0] } else { $null }
    # B closes the prompt text. An empty result makes PowerShell print its own "PS>", so B cannot go in the string then.
    if ([string]::IsNullOrEmpty($text)) { $Host.UI.Write((__dshWt_Osc '133;B')); return $text }
    "$text$(__dshWt_Osc '133;B')"
}

# C and E: wrap PSConsoleHostReadLine, which the host calls once per accepted line whatever key
# accepted it (Enter, Ctrl+J, history search...). A key-handler on Enter would miss those.
# Without PSReadLine there is no hook, so no blocks are cut (A/B/Cwd still work).
$readLine = $function:PSConsoleHostReadLine
if ($null -ne $readLine) {
    $global:__dshWt.OrigReadLine = $readLine
    function global:PSConsoleHostReadLine {
        $line = & $global:__dshWt.OrigReadLine
        try {
            $text = [string]$line
            if ($text.Trim().Length -gt 0) {
                $global:__dshWt.Ran = $true
                $Host.UI.Write((__dshWt_Osc "633;E;$(__dshWt_Esc $text)") + (__dshWt_Osc '133;C'))
            }
        } catch {}
        $line
    }
}
Remove-Variable readLine -ErrorAction Ignore
