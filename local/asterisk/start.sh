#!/bin/sh
set -eu
umask 027
mkdir -p /var/log/asterisk/cel-custom /var/spool/asterisk/monitor
touch /var/log/asterisk/cel-custom/Master.csv
exec /usr/sbin/asterisk -f -vvv -C /etc/asterisk/asterisk.conf
