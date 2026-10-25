# Authorship and third-party notices

OpenCode Agent Communicator was created and is maintained by **Yidi Sprei
([@YidiDev](https://github.com/YidiDev))**. Copyright in the original project work
is held by Yidi Sprei and licensed under the [MIT License](LICENSE).

This notice does not claim ownership of third-party software, independent
contributions, trademarks, or material that is not copyrightable. Contributors
retain copyright in their contributions unless separately agreed in writing.

## Software used

- [OpenCode](https://opencode.ai/v2/docs/): the host and public plugin, session,
  tool, and skill APIs. The pinned `@opencode/plugin` package declares MIT.
- [Effect](https://github.com/Effect-TS/effect): scoped effects, streams, and
  lifecycle composition. The pinned runtime package declares MIT.
- [Zod](https://github.com/colinhacks/zod): public argument validation. The pinned
  runtime package declares MIT.
- [Bun](https://bun.sh/), SQLite, and Linux filesystem facilities provide the
  execution and storage environment; they are separate upstream projects.

`THIRD_PARTY_LICENSES.json` inventories the exact installed production dependency
graph used for this release, including transitive packages and declared SPDX
license expressions. Its package links identify the upstream distributions.
The inventory is checked against a frozen installation, not a hand-maintained
list of only the three direct dependencies.

This is the release build's dependency snapshot. npm consumers can resolve a
different transitive graph or supply their own host peer dependency; they should
keep their own lockfile and review that installed graph. Neither this inventory
nor the build SBOM promises that all future npm resolutions are identical.

Dependencies are installed separately; their implementation code is not bundled
into this package archive. Their own licenses and notices govern their code and
must be retained when redistributing or bundling it. This project's MIT license
does not replace those licenses. Declared package metadata is not a substitute
for reviewing upstream license terms before creating a different distribution.

The SPDX license identifier and exception data used transitively are credited
to the [SPDX project](https://spdx.org/). The inventory records the distributions'
CC0-1.0 and CC-BY-3.0 declarations. This project does not modify those datasets.

## Development and release tooling

GitHub Actions, Google's Release Please, Biome, TypeScript, npm, and the test and
coverage libraries are independent upstream tools. Their use does not transfer
ownership to this project or imply endorsement by their maintainers. Release
automation uses the GitHub Actions bot identity; it does not impersonate the
project author.
