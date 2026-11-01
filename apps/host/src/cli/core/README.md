# Shared native CLI console

The console helper implements explicit styles, Rich's repr highlighting and Unicode cell wrapping
for small CLI messages. It does not parse arbitrary markup or emoji shortcodes. Commands with those
forms in a printed name/path delegate before mutation. Explicit older Unicode versions also defer.
The repr patterns, wrapping rules and Unicode 17 width data are adapted from Rich's Python sources
(`highlighter.py`, `_wrap.py`, `cells.py`, `_unicode_data/unicode17-0-0.py`); the retained MIT notice is
in `RICH-LICENSE.txt`. The Unicode table is static generated data, shared by every native message.
