param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
# Bootstrap only: this script handles paths, not credentials. A newly-created
# compiler cache is made private before any executable is placed inside it.
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
# Cold Windows images can spend most of the bootstrap deadline discovering
# modules for filesystem cmdlets. Fixed Framework APIs keep paths as data and
# preserve the same refusal of an existing target or a missing parent. The
# explicit owner/DACL is still attached at creation, before compiling a helper.
if ([IO.Directory]::Exists($Directory) -or [IO.File]::Exists($Directory)) { throw 'exists' }
$parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Directory))
if (-not [IO.Directory]::Exists($parent)) { throw 'parent' }
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
[System.IO.Directory]::CreateDirectory($Directory, $acl) | Out-Null
