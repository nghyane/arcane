# SSH

Remote host commands.
- Match commands to the remote host's OS/shell — verify shell type from available hosts
- Remote filesystems accessible at `~/.arcane/remote/<hostname>/`
- Unix (linux/bash, macos/zsh): `ls`, `cat`, `grep`, `find`, `ps`, `df`
- PowerShell: `Get-ChildItem`, `Get-Content`, `Select-String`, `Get-Process`
- Windows CMD: `dir`, `type`, `findstr`, `tasklist`