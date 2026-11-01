# Native core CLI helpers

`skillsCommand` ports the Python `skills path` and `skills install` bodies. The host receives
caller HOME through the optional typed `cli.exec.paths` context, never by mutating its environment.
An older shim can still use an explicit destination. The partial command tree returns `delegate`
before any output, input request or mutation for legacy help, parse errors and unsupported forms.
This is also the contract for later partial command groups.

The file comparison deliberately matches Python `filecmp`: ignored administrative directories,
byte comparisons, followed links and its existing `common_funny` type-clash behavior. Force replaces
only differing actual directories, never symlinks or files. Relative destinations use caller cwd;
`..` keeps its filesystem meaning across symlinks and its original spelling in messages.

The console helper implements explicit styles, Rich's repr highlighting and Unicode cell wrapping
for small CLI messages. It does not parse arbitrary markup or emoji shortcodes. Skills with those
forms in a printed name/path delegate before mutation. Explicit older Unicode versions also defer.
The repr patterns, wrapping rules and Unicode 17 width data are adapted from Rich's Python sources
(`highlighter.py`, `_wrap.py`, `cells.py`, `_unicode_data/unicode17-0-0.py`); the retained MIT notice is
in `RICH-LICENSE.txt`. The Unicode table is static generated data, shared by every native message.

A packaged skills resource location is part of the pending packaging contract. Source checkouts use
`.claude/skills`; callers can inject a known resource path. An unspecified packaged path delegates.
The other S39a commands remain delegated for their separately documented dependencies.
