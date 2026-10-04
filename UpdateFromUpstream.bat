@echo off
REM Updates this fork: pulls our branch, merges official SillyTavern release, then starts.
pushd %~dp0
git remote get-url upstream > nul 2>&1 || git remote add upstream https://github.com/SillyTavern/SillyTavern
call git pull --rebase --autostash
if %errorlevel% neq 0 goto failed
call git fetch upstream release
if %errorlevel% neq 0 goto failed
call git merge --no-edit upstream/release
if %errorlevel% neq 0 (
    echo [91mMerge conflict with upstream. Resolve it, commit, then run this again.[0m
    goto end
)
call git push
set NODE_ENV=production
call npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts
node server.js %*
goto end
:failed
echo [91mThere were errors while updating.[0m
:end
pause
popd
