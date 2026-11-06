param(
  [Parameter(Mandatory=$true)][string]$LiteralPath,
  [Parameter(Mandatory=$true)][ValidateSet('file','directory')][string]$Kind
)
$ErrorActionPreference = 'Stop'
$stage = 'IDENTITY'
try {
  # Read-only verification: do not create, follow a reparse point, repair ACLs
  # or take ownership of the original. Native attributes cover junctions that
  # are not represented by Node's symbolic-link bit.
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $stage = 'PATH'
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
    $stage = 'KIND'
    if (-not [System.IO.Directory]::Exists($full)) { throw 'kind' }
    $stage = 'ACL'
    $acl = [System.IO.DirectoryInfo]::new($full).GetAccessControl()
  } else {
    $stage = 'KIND'
    if (-not [System.IO.File]::Exists($full) -or [System.IO.Directory]::Exists($full)) { throw 'kind' }
    $stage = 'ACL'
    $acl = [System.IO.FileInfo]::new($full).GetAccessControl()
  }
  $stage = 'OWNER'
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
  $stage = 'AUDIENCE'
  foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        $rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18')) { throw 'audience' }
  }
  [Console]::Out.WriteLine('{"privateSource":true}')
} catch {
  # Only a closed verification stage crosses the pipe. Never print the path,
  # SID, ACL, native exception or any source bytes; a refusal grants no repair.
  [Console]::Error.WriteLine('AUDIO_SOURCE_INPUT_INVALID_' + $stage); exit 1
}
