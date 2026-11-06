param(
  [Parameter(Mandatory=$true)][string]$LiteralPath,
  [Parameter(Mandatory=$true)][ValidateSet('inspect','add-foreign-allow')][string]$Operation
)
$ErrorActionPreference = 'Stop'
try {
  # Development-only fixture metadata and mutation of its OWN synthetic file.
  # Never packaged; no SID/path/ACL values or exception prose enter its output.
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $file = [System.IO.FileInfo]::new($LiteralPath)
  $acl = $file.GetAccessControl()
  if ($Operation -eq 'add-foreign-allow') {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), 'Read', 'Allow')
    $acl.AddAccessRule($rule)
    $file.SetAccessControl($acl)
    [Console]::Out.WriteLine('{"fixtureChanged":true}')
  } else {
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    $parentAcl = $file.Directory.GetAccessControl()
    $answer = @{
      ownerMatchesUser = $owner -eq $identity.User.Value
      ownerMatchesDefault = $owner -eq $identity.Owner.Value
      parentOwnedByUser = $parentAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $identity.User.Value
      parentProtected = $parentAcl.AreAccessRulesProtected
    }
    [Console]::Out.WriteLine(($answer | ConvertTo-Json -Compress))
  }
} catch { [Console]::Error.WriteLine('AUDIO_TEST_NATIVE_PATH_FAILED'); exit 1 }
