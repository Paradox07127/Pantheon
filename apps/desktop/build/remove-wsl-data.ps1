# Runs remove-wsl-data.sh in the distro the app uses: the saved one, else the default one.
$settings = Join-Path $env:APPDATA 'Pantheon Desktop\settings.json'
$distro = if (Test-Path $settings) { (Get-Content -Raw $settings | ConvertFrom-Json).wslDistro }
$wsl = Join-Path $env:ProgramFiles 'WSL\wsl.exe'
if (-not (Test-Path $wsl)) { $wsl = 'wsl.exe' }
$target = if ($distro) { @('-d', $distro) } else { @() }
& $wsl @target --cd $PSScriptRoot --exec bash -l remove-wsl-data.sh
exit $LASTEXITCODE
