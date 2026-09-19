#!/bin/bash
# 윈도우 관리자 PowerShell 한 줄 생성: bash windows-oneliner.sh <sha40> <version>
echo "Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/dkdleld91-prog/momentinsight/$1/scripts/windows/update-naver-shopping-chrome-extension.ps1 -OutFile \"\$env:TEMP\\mi-update.ps1\"; powershell -ExecutionPolicy Bypass -File \"\$env:TEMP\\mi-update.ps1\" -ReleaseCommit ${1:0:7} -ExpectedVersion $2"
echo "# 기대 결과: MI_EXTENSION_UPDATE_OK release=${1:0:7} version=$2"
