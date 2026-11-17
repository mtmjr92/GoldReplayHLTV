@echo off
REM Starts GoldReplayHLTV on a local web server (needed to read the assets/ folder).
cd /d "%~dp0"
echo GoldReplayHLTV at http://localhost:8000/  (close this window to stop)
start "" http://localhost:8000/
python -m http.server 8000 --bind 127.0.0.1
