@echo off
cd /d "C:\Users\User\projects\botcode"
if not exist "data" mkdir "data"
echo. >> data\startup.log
echo [%date% %time%] starting botcode via npm run dev >> data\startup.log
npm run dev >> data\startup.log 2>&1
