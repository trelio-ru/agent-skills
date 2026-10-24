param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$stage = 'IDENTITY'
try {
  # Framework calls avoid loading filesystem/ACL modules under a restricted
  # bootstrap. A private directory must be secured before any job text is saved.
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User
  $stage = 'OWNER'
  if ([System.IO.Directory]::Exists($Directory)) {
    $attributes = [System.IO.File]::GetAttributes($Directory)
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
    $existing = [System.IO.DirectoryInfo]::new($Directory).GetAccessControl()
    if ($existing.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
  } else { [System.IO.Directory]::CreateDirectory($Directory) | Out-Null }
  $stage = 'ACL'
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  foreach ($principal in @($sid, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', $inherit, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  [System.IO.DirectoryInfo]::new($Directory).SetAccessControl($acl)
  $stage = 'VERIFY'
  $actual = [System.IO.DirectoryInfo]::new($Directory).GetAccessControl()
  if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'verification' }
  foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18')) { throw 'audience' }
  }
  [Console]::Out.WriteLine('{"privateStorage":true}')
} catch { [Console]::Error.WriteLine('AUDIO_PRIVATE_STORAGE_DENIED_' + $stage); exit 1 }
