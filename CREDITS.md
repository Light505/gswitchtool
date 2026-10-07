# Credits

GSwitch Claude Tool (repository `gswitchtool`) combines and modifies two
open-source projects. The original authors' commit history is preserved in
this repository.

GSwitch Claude Tool is not affiliated with or endorsed by Ginbing or OpenAI.

## GSwitch

- Source: <https://github.com/ginbing/GSwitch>
- Author: Ginbing and the GSwitch contributors
- License: GNU Affero General Public License v3.0 ([LICENSE](./LICENSE))

The root of this repository is a modified version of GSwitch 1.0.24 (upstream
commit `13b09c6`). Changes for gswitchtool began on 2026-10-06 and add an
optional Invoke Mode. They appear in this repository's history after that
commit and are summarized under "Fork scope: Invoke Mode" in
[PRODUCT.md](./PRODUCT.md). The modified program remains licensed under
AGPL-3.0.

## Codex plugin for Claude Code

- Source: <https://github.com/openai/codex-plugin-cc>
- Author: OpenAI and the codex-plugin-cc contributors
- License: Apache License 2.0
  ([LICENSE](./integrations/codex-plugin-cc/LICENSE),
  [NOTICE](./integrations/codex-plugin-cc/NOTICE))

[integrations/codex-plugin-cc](./integrations/codex-plugin-cc) is a modified
copy of codex-plugin-cc 1.0.6 (upstream commit `db52e28`). Each file changed
or added for gswitchtool carries a notice at its top, and the changes are
listed in this repository's history.

## Router plugin

`integrations/router-plugin` is original work by Light505 for gswitchtool
(2026), not derived from GSwitch or codex-plugin-cc.

## Modifications

Modifications for gswitchtool are by Light505.
