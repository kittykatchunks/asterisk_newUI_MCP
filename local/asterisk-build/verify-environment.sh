#!/bin/bash
set -euo pipefail
export LC_ALL=C

test "$(id -u)" -eq 0
test "$(cat /proc/1/comm)" = systemd
test "$(findmnt -n -o FSTYPE /)" = ext4
device=$(findmnt -n -o SOURCE /)
disk_bytes=$(blockdev --getsize64 "$device")
test "$disk_bytes" -le 42949672960
test "$disk_bytes" -ge 41875931136
printf 'ROOT_DISK_BYTES=%s\n' "$disk_bytes"
df -B1 /
while read -r target source type options; do
    if test "$target" = /usr/lib/wsl/drivers &&
        test "$source" = drivers &&
        test "$type" = 9p &&
        test "${options%%,*}" = ro; then
        echo READ_ONLY_WSL_DRIVER_MOUNT_PRESENT
    else
        echo "Unexpected host filesystem mount: $target $source $type $options" >&2
        exit 1
    fi
done < <(findmnt -rn -t 9p,drvfs -o TARGET,SOURCE,FSTYPE,OPTIONS)
if test -e /proc/sys/fs/binfmt_misc/WSLInterop; then
    echo 'Windows interop handler remains enabled' >&2
    exit 1
fi

probe_dir=/var/tmp/asterisk-build-fs-probe
mkdir "$probe_dir"
loop=
mounted=false
cleanup_fs_probe() {
    if "$mounted"; then
        umount "$probe_dir/mount"
    fi
    if test -n "$loop"; then
        losetup --detach "$loop"
    fi
    rm -f -- "$probe_dir/disk.img" "$probe_dir/write.stderr"
    rmdir "$probe_dir/mount" "$probe_dir"
}
trap cleanup_fs_probe EXIT
mkdir "$probe_dir/mount"
truncate --size=64M "$probe_dir/disk.img"
mkfs.ext4 -q -F "$probe_dir/disk.img"
loop=$(losetup --find --show "$probe_dir/disk.img")
mount "$loop" "$probe_dir/mount"
mounted=true
set +e
dd if=/dev/zero of="$probe_dir/mount/fill" bs=1048576 count=80 \
    2>"$probe_dir/write.stderr"
write_exit=$?
set -e
cat "$probe_dir/write.stderr"
test "$write_exit" -ne 0
grep -q 'No space left on device' "$probe_dir/write.stderr"
cleanup_fs_probe
trap - EXIT
echo SMALL_EXT4_ENOSPC_PROBE_OK

if id asterisk-build >/dev/null 2>&1; then
    echo 'Build user already exists; refusing to adopt it' >&2
    exit 1
fi
useradd --create-home --shell /bin/bash asterisk-build
systemd-run --unit=asterisk-build-resource-probe --wait --pipe --collect \
    --uid=asterisk-build \
    --property=CPUQuota=400% \
    --property=MemoryMax=4294967296 \
    --property=MemorySwapMax=0 \
    --property=TasksMax=256 \
    --property=RuntimeMaxSec=60 \
    --property=KillMode=control-group \
    --property=SendSIGKILL=yes \
    /bin/bash -eu -c '
        cg=$(sed -n "s/^0:://p" /proc/self/cgroup)
        base=/sys/fs/cgroup$cg
        read -r quota period < "$base/cpu.max"
        test "$quota" -eq "$((period * 4))"
        test "$(cat "$base/memory.max")" = 4294967296
        test "$(cat "$base/memory.swap.max")" = 0
        test "$(cat "$base/pids.max")" = 256
        test "$(id -u)" -ne 0
        for limit in cpu.max memory.max memory.swap.max pids.max; do
            printf "%s=" "$limit"
            cat "$base/$limit"
        done
        echo UNPRIVILEGED_CGROUP_PROBE_OK
    '

set +e
systemd-run --unit=asterisk-build-watchdog-probe --wait --pipe \
    --uid=asterisk-build \
    --property=CPUQuota=400% \
    --property=MemoryMax=4294967296 \
    --property=MemorySwapMax=0 \
    --property=TasksMax=256 \
    --property=RuntimeMaxSec=2 \
    --property=TimeoutStopSec=2 \
    --property=KillMode=control-group \
    --property=SendSIGKILL=yes \
    /bin/sleep 30
watchdog_exit=$?
set -e
test "$watchdog_exit" -ne 0
result=$(systemctl show asterisk-build-watchdog-probe.service --property=Result --value)
test "$result" = timeout
test "$(systemctl show asterisk-build-watchdog-probe.service --property=MainPID --value)" = 0
systemctl reset-failed asterisk-build-watchdog-probe.service
printf 'WATCHDOG_RESULT=%s\n' "$result"
echo ENVIRONMENT_VERIFIED_NO_DEPENDENCIES_INSTALLED
