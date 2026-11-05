# Changelog

## 0.1.0

- Initial VS Code extension: `antigravity` language model chat provider built on the shared
  Antigravity transport core from `../plugin`.
- Account model catalogue (17 chat + 1 image model on the reference account), cached with a
  manual refresh command.
- Streaming text, tool calls with `thoughtSignature` replay, image input, image-model output.
- Actionable translations for auth, quota, rate-limit and empty-response failures.
- Commands: show account status, refresh model list, show log. Settings for request shaping,
  thinking visibility, host override and log level.
- 22 offline checks, 4 live checks, and an extension-host smoke test that lists the account's
  18 models inside a real VS Code.
