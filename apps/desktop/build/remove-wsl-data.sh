# Stops the Pantheon daemon in this distro and deletes the folder that holds its runtime,
# data and worktrees. A login shell, like the one that unpacked the runtime, gives the same path.
base="${XDG_DATA_HOME:-$HOME/.local/share}/pantheon"
pkill -f "$base/runtime/"
# The daemon cancels its sessions before it exits; deleting earlier races their last writes.
n=0
while pgrep -f "$base/runtime/" >/dev/null && [ "$n" -lt 100 ]; do
  sleep 0.1
  n=$((n + 1))
done
pkill -9 -f "$base/runtime/"
rm -rf -- "$base"
