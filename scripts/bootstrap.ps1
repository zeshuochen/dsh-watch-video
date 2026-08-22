$ErrorActionPreference='Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$windowsPython = Join-Path $pluginRoot '.venv\Scripts\python.exe'
$unixPython = Join-Path $pluginRoot '.venv/bin/python'
$python = if (Test-Path $windowsPython) { $windowsPython } elseif (Test-Path $unixPython) { $unixPython } else { $null }
if (-not $python) {
  $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
  if (-not $pythonCommand) { throw 'Python was not found. Install Python 3.10+ or create .venv first.' }
  $python = $pythonCommand.Source
  & $python -m venv (Join-Path $pluginRoot '.venv')
  $python = if (Test-Path $windowsPython) { $windowsPython } else { $unixPython }
}
Write-Host "Using project Python: $python"
& $python -m pip install -r (Join-Path $pluginRoot 'requirements.txt')
