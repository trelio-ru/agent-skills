param([string]$Fixture, [ValidateSet('broaden','restore')][string]$Mode)
$ErrorActionPreference = 'Stop'
# Test-only file, not packaged. Broaden only the exact synthetic file during
# this test and restore its original DACL even when verification fails.
if ((Split-Path -Leaf $Fixture) -ne 'test.json') { throw 'fixture required' }
if ([System.IO.File]::ReadAllText($Fixture) -ne '{"synthetic":true}') { throw 'synthetic fixture required' }
if ($Mode -eq 'broaden') {
    $before = (Get-Acl -LiteralPath $Fixture).GetSecurityDescriptorSddlForm('All')
    $changed = Get-Acl -LiteralPath $Fixture
    $everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($everyone, 'Read', 'Allow')
    $changed.AddAccessRule($rule)
    Set-Acl -LiteralPath $Fixture -AclObject $changed
    [Console]::WriteLine($before)
} else {
    $before = [Console]::In.ReadToEnd().Trim()
    $restored = New-Object System.Security.AccessControl.FileSecurity
    $restored.SetSecurityDescriptorSddlForm($before)
    Set-Acl -LiteralPath $Fixture -AclObject $restored
}
exit 0
