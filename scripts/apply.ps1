# Elevated: create/update a Standard TCP/IP port and repoint the print queue, then set it default.
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)
$ErrorActionPreference = 'Stop'
$steps = New-Object System.Collections.Generic.List[string]
$result = [ordered]@{ ok = $false; steps = @(); error = $null }

function Save([hashtable]$h) {
  $h.steps = @($steps)
  [IO.File]::WriteAllText($ResultPath, ($h | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
}

try {
  $cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Import-Module PrintManagement -ErrorAction Stop

  $portName = [string]$cfg.portName
  $hostAddress = [string]$cfg.hostAddress
  $portNumber = [int]$cfg.portNumber
  $queueName = [string]$cfg.queueName
  $driverName = [string]$cfg.driverName

  # 1. Port: create, or update its address in place.
  $escapedPort = $portName.Replace("'", "''")
  $port = Get-CimInstance -ClassName Win32_TCPIPPrinterPort -Filter "Name='$escapedPort'" -ErrorAction SilentlyContinue
  if ($null -eq $port) {
    Add-PrinterPort -Name $portName -PrinterHostAddress $hostAddress -PortNumber $portNumber -ErrorAction Stop
    $steps.Add("port-created:$portName->$hostAddress")
    $portChanged = $true
  }
  elseif ($port.HostAddress -ne $hostAddress -or [int]$port.PortNumber -ne $portNumber) {
    $port.HostAddress = $hostAddress
    $port.PortNumber = [uint32]$portNumber
    Set-CimInstance -InputObject $port -ErrorAction Stop
    $steps.Add("port-updated:$portName->$hostAddress")
    $portChanged = $true
  }
  else {
    $steps.Add("port-unchanged:$portName->$hostAddress")
    $portChanged = $false
  }

  # 2. Queue: repoint an existing queue, or create it with the already-installed driver.
  $stored = Get-CimInstance -ClassName Win32_TCPIPPrinterPort -Filter "Name='$escapedPort'" -ErrorAction SilentlyContinue
  if ($null -ne $stored) { $steps.Add("port-stored:$($stored.HostAddress):$($stored.PortNumber)") }
  $printer = Get-Printer -Name $queueName -ErrorAction SilentlyContinue
  if ($null -eq $printer) {
    $driver = Get-PrinterDriver -Name $driverName -ErrorAction SilentlyContinue
    if ($null -eq $driver) { throw "driver-not-installed: $driverName" }
    Add-Printer -Name $queueName -DriverName $driverName -PortName $portName -ErrorAction Stop
    $steps.Add("queue-created:$queueName")
  }
  elseif ($printer.PortName -ne $portName) {
    Set-Printer -Name $queueName -PortName $portName -ErrorAction Stop
    $steps.Add("queue-repointed:$($printer.PortName)->$portName")
  }
  else {
    $steps.Add("queue-unchanged:$queueName")
  }

  # 3. Default printer.
  if ($cfg.makeDefault) {
    $escapedQueue = $queueName.Replace("'", "''")
    $wmiPrinter = Get-CimInstance -ClassName Win32_Printer -Filter "Name='$escapedQueue'" -ErrorAction Stop
    $wmiPrinter | Invoke-CimMethod -MethodName SetDefaultPrinter | Out-Null
    $steps.Add("default-set:$queueName")
  }

  # 4. Stop Windows from silently switching the default based on last use.
  $winKey = 'HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows'
  New-Item -Path $winKey -Force | Out-Null
  Set-ItemProperty -Path $winKey -Name 'LegacyDefaultPrinterMode' -Value 1 -Type DWord
  $steps.Add("legacy-default-mode:1")

  # The spooler reads the port address when it opens the next connection, so no restart is needed.

  Save @{ ok = $true; steps = @(); error = $null }
  exit 0
}
catch {
  Save @{ ok = $false; steps = @(); error = $_.Exception.Message }
  exit 1
}
