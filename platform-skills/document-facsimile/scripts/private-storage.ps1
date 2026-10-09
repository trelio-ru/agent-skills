param(
  [Parameter(Mandatory=$true)][string]$Target,
  [switch]$CreateDirectory,
  [switch]$ProtectNewFile
)
$ErrorActionPreference = 'Stop'

# The signed helper accepts paths only as data. A new private directory gets
# its DACL before publication; existing unsafe storage is never repaired into
# looking trusted. MachinePolicy/UserPolicy retain their normal precedence.
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($CreateDirectory) {
  if (Test-Path -LiteralPath $Target) { throw 'already_exists' }
  $parent = Split-Path -Parent $Target
  if (!(Test-Path -LiteralPath $parent -PathType Container)) { throw 'missing_parent' }
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
  )
  $acl.AddAccessRule($rule)
  [System.IO.Directory]::CreateDirectory($Target, $acl) | Out-Null
}
$item = Get-Item -LiteralPath $Target -Force
if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'reparse_point' }
$security = Get-Acl -LiteralPath $Target
$owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $sid.Value) {
  # Elevated Windows processes can initially assign their token's Owner group
  # to new files. Only exclusive-created files may be retitled to User SID;
  # previously stored material always requires the exact user owner already.
  $tokenOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().Owner
  if (!$ProtectNewFile -or $owner.Value -ne $tokenOwner.Value) { throw 'unexpected_owner' }
}
if ($ProtectNewFile) {
  # Python has just created this exact regular file with exclusive-create.
  # Removing inherited grants is safe only on that newly owned output; the
  # check-only path never changes previously existing private material.
  if ($item.PSIsContainer) { throw 'expected_file' }
  $security = New-Object System.Security.AccessControl.FileSecurity
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
  Set-Acl -LiteralPath $Target -AclObject $security
  $security = Get-Acl -LiteralPath $Target
}
$rules = $security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
$allow = $false
foreach ($rule in $rules) {
  if ($rule.AccessControlType -eq 'Allow') {
    if ($rule.IdentityReference.Value -ne $sid.Value) { throw 'other_reader' }
    if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) { $allow = $true }
  }
}
if (!$allow) { throw 'missing_owner_access' }
