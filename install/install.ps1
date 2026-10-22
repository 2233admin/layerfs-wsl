<#
Installs layerfs-wsl on Windows:
  1. a WSL distro, Arch Linux or Ubuntu 24.04 (created when missing; systemd on),
  2. inside it, install/distro-setup.sh: Docker on the distro's own container network,
     LayerFS, images, the bridge and the page,
  3. a logon task that keeps the distro running (install/keepalive.ps1),
  4. this checkout as a user-scoped OMP plugin (omp plugin link).
Run again to resume or repair; finished steps are skipped.

  powershell -ExecutionPolicy Bypass -File install\install.ps1 [-Distro layerfs-lab] [-Base archlinux|Ubuntu-24.04] [-Location D:\wsl\layerfs-lab] [-FromSource] [-NoPlugin]

-Base picks the Linux of a new distro (default archlinux); an existing distro is used as it is.
-Distro other than layerfs-lab: /layerfs init takes it as its last argument and writes it
into the folder's .omp/layerfs.json, which every later call follows.
-FromSource builds the LayerFS core bundle (a release cargo build, tens of minutes)
instead of downloading this repository's release asset.
#>
param(
	[string]$Distro = "layerfs-lab",
	[ValidateSet("archlinux", "Ubuntu-24.04")]
	[string]$Base = "archlinux",
	[string]$Location,
	[switch]$FromSource,
	[switch]$NoPlugin
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$env:WSL_UTF8 = "1"   # wsl.exe prints UTF-8 instead of UTF-16

function Invoke-Wsl {
	& wsl.exe @args
	if ($LASTEXITCODE -ne 0) { throw "wsl.exe $($args -join ' ') exited $LASTEXITCODE" }
}

$have = @(wsl.exe --list --quiet) | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($have -notcontains $Distro) {
	if (-not $Location) { $Location = Join-Path $env:USERPROFILE "wsl\$Distro" }
	Write-Host "== creating WSL distro $Distro ($Base) at $Location"
	Invoke-Wsl --install $Base --name $Distro --location $Location --no-launch --web-download
}

$pid1 = (wsl.exe -d $Distro -u root --exec cat /proc/1/comm | Out-String).Trim()
if ($pid1 -ne "systemd") {
	Write-Host "== turning systemd on in $Distro"
	Invoke-Wsl -d $Distro -u root --exec sh -c "grep -qx 'systemd=true' /etc/wsl.conf 2>/dev/null || printf '[boot]\nsystemd=true\n' >> /etc/wsl.conf"
	Invoke-Wsl --terminate $Distro
}

$linuxRepo = (wsl.exe -d $Distro -u root --exec wslpath -a $repo | Out-String).Trim()
$setup = @("-d", $Distro, "-u", "root", "--exec", "bash", "$linuxRepo/install/distro-setup.sh")
if ($FromSource) { $setup += "--from-source" }
Invoke-Wsl @setup

Write-Host "== keeping $Distro running while you are logged on"
& (Join-Path $PSScriptRoot "keepalive.ps1") -Distro $Distro

if (-not $NoPlugin) {
	Write-Host "== linking $repo as the OMP plugin layerfs-wsl"
	& omp plugin link $repo
	if ($LASTEXITCODE -ne 0) { throw "omp plugin link exited $LASTEXITCODE" }
}
if ($NoPlugin) {
	Write-Host "done. Create a project with the bridge (any agent harness; see docs\other-harnesses.md):"
	Write-Host "  wsl -d $Distro -u root --exec /opt/layerfs-wsl/lfs-wsl.sh init hello lfsb-rust-sandbox:2 /root/layerfs-wsl/fixtures/hello"
} else {
	$distroArg = if ($Distro -ne "layerfs-lab") { " $Distro" } else { "" }
	Write-Host "done. In OMP, bind a folder to a new project with:"
	Write-Host "  /layerfs init hello lfsb-rust-sandbox:2 /root/layerfs-wsl/fixtures/hello$distroArg"
	Write-Host "Other agent harnesses use the bridge directly: docs\other-harnesses.md"
}
