$ErrorActionPreference = 'Stop'
try {
  # Node writes UTF-8 pipes regardless of the interactive Windows code page.
  # Explicit encoding preserves Unicode operator paths without emitting a BOM.
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  # stdin is private host transport. Paths and values are data, never interpolated
  # into PowerShell code; no credential passes through argv or environment.
  # Native filesystem calls took over twenty seconds per helper on the hosted
  # Windows image. Fixed Framework assemblies and direct filesystem APIs avoid
  # repeated cmdlet discovery; paths and packets never become executable code.
  [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35') | Out-Null
  $json = [Web.Script.Serialization.JavaScriptSerializer]::new()
  $json.MaxJsonLength = 8 * 1024 * 1024
  $packet = $json.DeserializeObject([Console]::In.ReadToEnd())
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  function Assert-Path([string]$path, [bool]$leafRequired) {
    $cursor = [IO.Path]::GetFullPath($path)
    $first = $true
    while ($cursor) {
      try {
        $attributes = [IO.File]::GetAttributes($cursor)
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse' }
      } catch [IO.FileNotFoundException] {
        if ($first -and $leafRequired) { throw 'missing' }
      } catch [IO.DirectoryNotFoundException] {
        if ($first -and $leafRequired) { throw 'missing' }
      }
      $parent = [IO.Path]::GetDirectoryName($cursor)
      if ($parent -eq $cursor) { break }; $cursor = $parent; $first = $false
    }
  }
  function Assert-Private([string]$path) {
    Assert-Path $path $true
    if ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::Directory) { $acl = [IO.Directory]::GetAccessControl($path) }
    else { $acl = [IO.File]::GetAccessControl($path) }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
    if (-not $acl.AreAccessRulesProtected) { throw 'inheritance' }
    $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or
        $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') { throw 'acl' }
  }
  function Create-Directory([string]$path) {
    Assert-Path $path $false
    if ([IO.Directory]::Exists($path)) { Assert-Private $path; return }
    if ([IO.File]::Exists($path)) { throw 'directory' }
    $parent = [IO.Path]::GetDirectoryName($path)
    if (-not [IO.Directory]::Exists($parent)) { Create-Directory $parent }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    # Create with the explicit DACL; private material never exists under an
    # inherited broad ACL, including on an elevated Windows session.
    [IO.Directory]::CreateDirectory($path, $acl) | Out-Null
    Assert-Private $path
  }
  if ($packet.mode -eq 'directory') { Create-Directory $packet.path; [Console]::Out.Write('ok') }
  elseif ($packet.mode -eq 'directories') {
    if ($packet.paths.Count -ne 5) { throw 'paths' }
    foreach ($privatePath in $packet.paths) { Create-Directory $privatePath }
    [Console]::Out.Write('ok')
  }
  elseif ($packet.mode -eq 'check') { Assert-Private $packet.path; [Console]::Out.Write('ok') }
  elseif ($packet.mode -eq 'write') {
    Assert-Private ([IO.Path]::GetDirectoryName($packet.path)); Assert-Path $packet.path $false
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
    $stream = [IO.FileStream]::new($packet.path, 'CreateNew', 'Write', 'None', 4096, 'None', $acl)
    try { $bytes = [Convert]::FromBase64String($packet.data); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
    Assert-Private $packet.path; [Console]::Out.Write('ok')
  }
  elseif ($packet.mode -eq 'seal' -or $packet.mode -eq 'open') {
    [Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a') | Out-Null
    $bytes = [Convert]::FromBase64String($packet.data)
    $entropy = [Text.Encoding]::UTF8.GetBytes('trelio/vk-ads/v1/' + $packet.account)
    if ($packet.mode -eq 'seal') { $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, 'CurrentUser') }
    else { $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, 'CurrentUser') }
    [Console]::Out.Write([Convert]::ToBase64String($result)); [Array]::Clear($bytes, 0, $bytes.Length)
  }
  else { throw 'mode' }
} catch { exit 2 }
