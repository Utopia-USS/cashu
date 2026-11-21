# Packaged content build (host protocol 1.5)

Packaged GUI, host, and CLI derive `desktop-<Info version>-<content digest>` from their own verified app bundle. The digest covers every regular file under `Contents`, including frameworks, and every contained relative symlink and its link text. The resource manifest is checked separately. An exact copied app has the same build; a modified resource, framework, executable, or link has a different build. The path-sensitive bundle fingerprint remains separate and is used for update handover and whole-app replacement detection.

For a packaged build, the host refuses `ui`, `cli`, and `mcp` hello messages with a different build. The client also checks the authenticated host challenge before it sends its proof. `admin` retains authenticated cross-build access for graceful status, stop, and handover during replacement. Development builds retain their earlier flexible build labels. Protocol minor 1.5 adds the fixed `build` refusal reason; the frame, token, role, and proof formats remain unchanged.

This prevents accidental mixed-code writer sessions between same-version app copies. The data-dir token and build label are not an OS security boundary against malicious code running as the same user, which can read the token and choose its own hello fields.
