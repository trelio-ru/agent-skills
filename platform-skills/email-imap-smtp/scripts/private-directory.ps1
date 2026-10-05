param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
# Bootstrap only: this script handles paths, not credentials. The Python
# wrapper invokes it with a process-only execution-policy bypass because a
# normal Windows profile may forbid repository scripts. The machine and user
# policies remain unchanged. A newly-created compiler cache is made private
# before any executable is placed inside it.
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if (Test-Path -LiteralPath $Directory) { throw 'exists' }
$parent = Split-Path -Parent $Directory
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'parent' }
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
[System.IO.Directory]::CreateDirectory($Directory, $acl) | Out-Null
