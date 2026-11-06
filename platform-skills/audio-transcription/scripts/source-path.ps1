param(
  [Parameter(Mandatory=$true)][string]$LiteralPath,
  [Parameter(Mandatory=$true)][ValidateSet('file','directory')][string]$Kind
)
$ErrorActionPreference = 'Stop'
try {
  # Read-only verification: do not create, follow a reparse point, repair ACLs
  # or take ownership of the original. Native attributes cover junctions that
  # are not represented by Node's symbolic-link bit.
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $full = [System.IO.Path]::GetFullPath($LiteralPath)
  $cursor = $full
  while ($cursor) {
    $attributes = [System.IO.File]::GetAttributes($cursor)
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
    $parent = [System.IO.Directory]::GetParent($cursor)
    if ($null -eq $parent) { break }
    $cursor = $parent.FullName
  }
  if ($Kind -eq 'directory') {
    if (-not [System.IO.Directory]::Exists($full)) { throw 'kind' }
    $acl = [System.IO.DirectoryInfo]::new($full).GetAccessControl()
  } else {
    if (-not [System.IO.File]::Exists($full) -or [System.IO.Directory]::Exists($full)) { throw 'kind' }
    $acl = [System.IO.FileInfo]::new($full).GetAccessControl()
  }
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
  foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        $rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18')) { throw 'audience' }
  }
  [Console]::Out.WriteLine('{"privateSource":true}')
} catch { [Console]::Error.WriteLine('AUDIO_SOURCE_INPUT_INVALID'); exit 1 }
