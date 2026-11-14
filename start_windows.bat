@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Python не найден. Установите Python 3.11+ с python.org.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  py -m venv .venv
  if errorlevel 1 (
    echo Не удалось создать виртуальное окружение.
    pause
    exit /b 1
  )
)
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo Не удалось установить зависимости. Проверьте интернет.
  pause
  exit /b 1
)
echo.
echo Сайт будет доступен по адресу http://127.0.0.1:5000
start "" "http://127.0.0.1:5000"
".venv\Scripts\python.exe" app.py
pause
