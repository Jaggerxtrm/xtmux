# Normalizes volatile tokens in picker stdout/journal so V1 goldens are stable
# across runs, hosts, and processes. Order matters: most specific first.
s|"ts":"[^"]*"|"ts":"<TS>"|g
s|"head":"[0-9a-f]*"|"head":"<SHA>"|g
s|m[0-9]\{10\}-[0-9A-Za-z]*-[0-9]*|<MONITOR_ID>|g
s|^monitor\t<MONITOR_ID>\t[0-9]*\t|monitor\t<MONITOR_ID>\t<PID>\t|
s|/tmp/[A-Za-z0-9._/-]*|<TMP>|g
s|%[0-9]\{1,\}|<PANE>|g
s|\$[0-9]\{1,\}|<SESSION_ID>|g
s|"ts_epoch":[0-9]\{1,\}|"ts_epoch":<EPOCH>|g
s|\b[0-9]\{10\}\b|<EPOCH>|g
s|pid=[0-9]\{1,\}|pid=<PID>|g
s|"pid":"[0-9]\{1,\}"|"pid":"<PID>"|g
