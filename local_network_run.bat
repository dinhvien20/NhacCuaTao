@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "LAN_IP="

for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -Command "$ip = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | ForEach-Object { $_.IPv4Address[0].IPAddress } | Select-Object -First 1; if ($ip) { Write-Output $ip }"`) do set "LAN_IP=%%I"

if not defined LAN_IP (
  for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceOperationalStatus -eq 'Up' -and $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } | Select-Object -First 1 -ExpandProperty IPAddress"`) do set "LAN_IP=%%I"
)

if not defined LAN_IP (
  echo Could not detect a LAN IPv4 address. Check Wi-Fi or Ethernet connectivity.
  set "LAN_IP=<LAN-IP>"
)

where py >nul 2>nul
if errorlevel 1 (
  echo Python Launcher ^(py^) was not found. Install Python and enable the launcher.
  pause
  exit /b 1
)

py -3 -c "import mutagen, imageio_ffmpeg" >nul 2>nul
if errorlevel 1 (
  echo Installing backend requirements...
  py -3 -m pip install -r "%PROJECT_DIR%backend\requirements.txt"
  if errorlevel 1 (
    echo Dependency installation failed. Review the output above.
    pause
    exit /b 1
  )
)

echo.
echo ============================================================
echo  NhacCuaTao - Local Network Test
echo ============================================================
echo  Host computer: http://localhost:8080
echo  Backend API:   http://localhost:5000/api/health
echo  LAN device:    http://%LAN_IP%:8080
echo  LAN API:       http://%LAN_IP%:5000/api/health
echo.
echo  Connect the phone/computer to the same Wi-Fi.
echo  If it cannot connect, allow inbound TCP ports 5000 and 8080
echo  for the Private Windows Firewall profile.
echo  These test services are unauthenticated; do not expose them
echo  to public networks.
echo ============================================================
echo.

start "NhacCuaTao Backend - 5000" /D "%PROJECT_DIR%" py -3 backend\app.py
start "NhacCuaTao Frontend - 8080" /D "%PROJECT_DIR%" py -3 -m http.server 8080 --directory frontend --bind 0.0.0.0

echo Backend and frontend launched in separate windows.
echo Keep those windows open while testing.
pause
endlocal