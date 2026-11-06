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
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User
  $defaultOwner = $identity.Owner
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
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($owner -ne $sid.Value) {
    # Windows creates files with the token's default owner, which need not be
    # TokenUser for an elevated caller. This is NOT an Administrators exception:
    # only the fresh OS-selected owner of THIS caller may qualify, only for a
    # file inside a protected same-user private directory. Other owners and
    # directory ownership remain strict, and no ownership/ACL is ever repaired.
    # https://learn.microsoft.com/windows/win32/secauthz/owner-of-a-new-object
    if ($Kind -ne 'file' -or $null -eq $defaultOwner -or $owner -ne $defaultOwner.Value) { throw 'owner' }
    $parent = [System.IO.Directory]::GetParent($full)
    if ($null -eq $parent) { throw 'parent' }
    $parentAcl = $parent.GetAccessControl()
    if ($parentAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'parent-owner' }
    $stage = 'ACL'
    if (-not $parentAcl.AreAccessRulesProtected) { throw 'parent-acl' }
    $stage = 'AUDIENCE'
    foreach ($rule in $parentAcl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
          $rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18')) { throw 'parent-audience' }
    }
  }
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
