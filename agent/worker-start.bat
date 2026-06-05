@echo off
REM Dynamic Research worker daemon launcher.
REM Registered as Windows Scheduled Task "DynamicResearchWorker" (every 5 min).
REM
REM Key detail: uses `start "TITLE" /MIN cmd /c "..."` to spawn the worker in a
REM NEW console group. Without this, the worker inherits the Task Scheduler's
REM (which can in turn be in the user session's interactive console) console
REM group, and any sibling bash subshell exiting in that session fires
REM CTRL_CLOSE_EVENT to all members — killing the worker AND its claude.exe
REM subprocess child (which surfaces as STATUS_CONTROL_C_EXIT = 3221225786).
REM S42 bugs 44 + 45 + 46. This outer .bat exits immediately after `start`;
REM the spawned cmd+node continue indefinitely in their detached console.
cd /d "C:\Users\ceo\Documents\AI Training\Anti Gravity\Dynamic Research\agent"
start "DynamicResearchWorker" /MIN cmd /c "node --env-file=.env --import=tsx worker.ts >> worker.log 2>&1"
