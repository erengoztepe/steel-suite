@echo off
cd /d "%~dp0"

REM --- Node kurulu degilse standart yolu PATH'e ekle (winget ile kurulmus olabilir) ---
where npm >nul 2>nul
if errorlevel 1 set "PATH=%PATH%;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs"

where npm >nul 2>nul
if errorlevel 1 (
  echo [HATA] npm bulunamadi. Once KURULUM.txt icindeki tek satirlik kurulum komutunu calistir.
  echo.
  pause
  exit /b 1
)

REM --- Bagimliliklar yuklenmemisse uyar ---
if not exist "node_modules" (
  echo [HATA] node_modules yok. Once KURULUM.txt icindeki kurulum komutunu calistir.
  echo.
  pause
  exit /b 1
)

REM --- ".ideaCon" koprusunun kullanacagi Python (dev server bunu miras alir) ---
if exist "%LocalAppData%\Programs\Python\Python313\python.exe" (
  set "IDEA_PYTHON=%LocalAppData%\Programs\Python\Python313\python.exe"
) else (
  for /f "delims=" %%P in ('where python 2^>nul') do set "IDEA_PYTHON=%%P"
)
if not defined IDEA_PYTHON (
  echo [UYARI] Python bulunamadi - ".ideaCon" butonu calismaz ^(XML export calisir^).
) else (
  echo [IDEA] .ideaCon koprusu icin Python: "%IDEA_PYTHON%"
)

echo [IDEA] ".ideaCon" butonu icin REST API gerekli - api.bat'i ayrica calistir.
echo.
npm run dev
pause
