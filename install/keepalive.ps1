<#
Keeps a WSL distro running while you are logged on. WSL stops a distro a few seconds after
the last wsl.exe process that uses it exits; that also stops its dockerd, the LayerFS
clients, their pages and every mounted Workspace. This registers a per-user logon task
"layerfs-bridge keepalive <distro>" that holds one hidden wsl.exe (sleep infinity) open, and
starts it now.

  powershell -ExecutionPolicy Bypass -File install\keepalive.ps1 [-Distro layerfs-lab] [-Remove]
#>
param(
	[string]$Distro = "layerfs-lab",
	[switch]$Remove
)
$ErrorActionPreference = "Stop"
$name = "layerfs-bridge keepalive $Distro"

if ($Remove) {
	Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
	Unregister-ScheduledTask -TaskName $name -Confirm:$false
	Write-Host "removed task $name"
	return
}
# conhost --headless: no console window for the wsl.exe the task starts
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
	-Argument "--headless $env:WINDIR\System32\wsl.exe -d $Distro -u root --exec sleep infinity"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
	-DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Host "task $name registered and started: $Distro stays running while you are logged on"
