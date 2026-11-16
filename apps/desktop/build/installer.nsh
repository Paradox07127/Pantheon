; Built on macOS, the uninstaller carries the installer's stub and icon, so its own CRC never
; matches and it exits with code 2, which blocks every upgrade. The installer's CRC still
; covers the uninstaller it carries.
!ifdef BUILD_UNINSTALLER
  CRCCheck off

  ; Inside a macro, __FILEDIR__ names the file that inserts it, so this folder is kept here.
  !define PANTHEON_BUILD_DIR "${__FILEDIR__}"

  ; 1 when the user ticks the box; silent uninstalls, which upgrades run, never show the page.
  Var pantheonDeleteData
  Var pantheonDeleteDataBox

  !macro customUnWelcomePage
    !insertmacro MUI_UNPAGE_WELCOME
    !include nsDialogs.nsh
    UninstPage custom un.pantheonDataPage un.pantheonDataPageLeave

    Function un.pantheonDataPage
      ${if} ${isUpdated}
        Abort
      ${endif}
      ${if} $LANGUAGE == 2052
        !insertmacro MUI_HEADER_TEXT "Pantheon 数据" ""
        StrCpy $1 "同时删除 Windows 和 WSL 里的 Pantheon 数据(含会话记录和 worktree)"
      ${else}
        !insertmacro MUI_HEADER_TEXT "Pantheon data" ""
        StrCpy $1 "Also delete Pantheon data on Windows and in WSL, including sessions and worktrees"
      ${endif}
      nsDialogs::Create 1018
      Pop $0
      ${NSD_CreateCheckbox} 0 0 100% 24u "$1"
      Pop $pantheonDeleteDataBox
      nsDialogs::Show
    FunctionEnd

    Function un.pantheonDataPageLeave
      ${NSD_GetState} $pantheonDeleteDataBox $pantheonDeleteData
    FunctionEnd
  !macroend

  !macro customUnInstall
    ${if} $pantheonDeleteData == 1
      ; The WSL script reads the distro from the Windows settings, so it runs first.
      File "/oname=$PLUGINSDIR\remove-wsl-data.ps1" "${PANTHEON_BUILD_DIR}/remove-wsl-data.ps1"
      File "/oname=$PLUGINSDIR\remove-wsl-data.sh" "${PANTHEON_BUILD_DIR}/remove-wsl-data.sh"
      ; The uninstaller is 32-bit; System32 would give it a 32-bit PowerShell that cannot see wsl.exe.
      nsExec::Exec `"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\remove-wsl-data.ps1"`
      Pop $0
      ; The Windows settings name the distro, so they stay when the WSL data could not be deleted.
      ${if} $0 == 0
        RMDir /r "$APPDATA\Pantheon Desktop"
      ${elseif} $LANGUAGE == 2052
        MessageBox MB_OK|MB_ICONEXCLAMATION "无法删除 WSL 里的 Pantheon 数据,Windows 侧的设置已保留。"
      ${else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Could not delete the Pantheon data in WSL; the Windows settings were kept."
      ${endif}
    ${endif}
  !macroend
!endif
