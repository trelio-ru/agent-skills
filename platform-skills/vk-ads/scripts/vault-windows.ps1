$ErrorActionPreference = 'Stop'
try {
  # stdin is private host transport. Paths and values are data, never interpolated
  # into PowerShell code; no credential passes through argv or environment.
  $packet = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  function Assert-Path([string]$path, [bool]$leafRequired) {
    $cursor = [IO.Path]::GetFullPath($path)
    if ($leafRequired -and -not (Test-Path -LiteralPath $cursor)) { throw 'missing' }
    while ($cursor) {
      if (Test-Path -LiteralPath $cursor) {
        $item = Get-Item -LiteralPath $cursor -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse' }
      }
      $parent = [IO.Path]::GetDirectoryName($cursor)
      if ($parent -eq $cursor) { break }; $cursor = $parent
    }
  }
  function Assert-Private([string]$path) {
    Assert-Path $path $true
    $acl = Get-Acl -LiteralPath $path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
    if (-not $acl.AreAccessRulesProtected) { throw 'inheritance' }
    $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or
        $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') { throw 'acl' }
  }
  function Create-Directory([string]$path) {
    Assert-Path $path $false
    if (Test-Path -LiteralPath $path) { Assert-Private $path; return }
    $parent = [IO.Path]::GetDirectoryName($path)
    if (-not (Test-Path -LiteralPath $parent)) { Create-Directory $parent }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    # Create with the explicit DACL; private material never exists under an
    # inherited broad ACL, including on an elevated Windows session.
    [IO.Directory]::CreateDirectory($path, $acl) | Out-Null
    Assert-Private $path
  }
  if ($packet.mode -eq 'directory') { Create-Directory $packet.path; [Console]::Out.Write('ok') }
  elseif ($packet.mode -eq 'check') { Assert-Private $packet.path; [Console]::Out.Write('ok') }
  elseif ($packet.mode -eq 'write') {
    Assert-Private ([IO.Path]::GetDirectoryName($packet.path)); Assert-Path $packet.path $false
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
    $stream = New-Object IO.FileStream($packet.path, 'CreateNew', 'Write', 'None', 4096, 'None', $acl)
    try { $bytes = [Convert]::FromBase64String($packet.data); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
    Assert-Private $packet.path; [Console]::Out.Write('ok')
  }
  elseif ($packet.mode -eq 'seal' -or $packet.mode -eq 'open') {
    Add-Type -AssemblyName System.Security
    $bytes = [Convert]::FromBase64String($packet.data)
    $entropy = [Text.Encoding]::UTF8.GetBytes('trelio/vk-ads/v1/' + $packet.account)
    if ($packet.mode -eq 'seal') { $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, 'CurrentUser') }
    else { $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, 'CurrentUser') }
    [Console]::Out.Write([Convert]::ToBase64String($result)); [Array]::Clear($bytes, 0, $bytes.Length)
  }
  else { throw 'mode' }
} catch { exit 2 }
