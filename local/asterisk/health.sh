#!/bin/sh
set -eu
asterisk -rx 'core waitfullybooted' | grep -q 'fully booted'
for module in chan_pjsip app_queue app_mixmonitor cel_custom res_srtp; do
    asterisk -rx "module show like $module.so" | grep -q 'Running'
done
asterisk -rx 'cel show status' | grep -q 'CEL Custom CSV Logging'
test -w /var/log/asterisk/cel-custom
test -w /var/spool/asterisk/monitor
