# Temporary GLib 0.18.5 security backport

**Advisory:** [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) / [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) / [Auvra Dependabot #36](https://github.com/dovvnloading/Auvra/security/dependabot/36)

## Why an ordinary upgrade cannot fix this

Auvra's desktop player depends on Wry/Tao. Their Linux GTK3/WebKitGTK crates require the `glib ^0.18` family. The first upstream release with the corrected `VariantStrIter` iterator is `glib 0.20.0`, which is incompatible with the current GTK3 stack. Simply setting `glib = "0.20"` or updating the lockfile will not produce a valid dependency graph.

## Remediation

The `player-desktop/Cargo.toml` `[patch.crates-io]` section selects a **commit-pinned** source of `glib 0.18.5` at [7e91f1a9420fd3e6c58b7913bbbf201888304ea9](https://github.com/andrew-wommack-ministries/glib-rustsec-2024-0429-backport/commit/7e91f1a9420fd3e6c58b7913bbbf201888304ea9). This is based on the original published 0.18.5 crate, with upstream [gtk-rs/gtk-rs-core#1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343) backported into `src/variant_iter.rs`.

Review of the backport repository's history found:

- `add08a2c3c1162d6962678cd37380fdeb15ef400`: initial published-crate snapshot
- `9e2bb20e2daba5b4dc5e2c9f4dee0797a1503b9f`: only two changed source lines: `let p` becomes `let mut p`, and the `g_variant_get_child` output argument `&p` becomes `&mut p`
- `7e91f1a9420fd3e6c58b7913bbbf201888304ea9`: adds only `PATCH-README.md`

The crate version remains **0.18.5**. This repairs the known implementation issue in the selected code; it does **not** represent a scanner-recognized upstream patched release. A version-only advisory scanner may still show #36 until it recognizes the Git dependency or until GTK is migrated. **Do not dismiss a remaining warning automatically.**

## Validation and removal

On a machine with Rust and the Linux GTK/WebKitGTK system packages installed, verify:

```sh
cargo metadata --manifest-path player-desktop/Cargo.toml --locked --format-version 1
cargo tree --manifest-path player-desktop/Cargo.toml --locked -i glib
cargo test --manifest-path player-desktop/Cargo.toml --locked
```

The Cargo lockfile must identify `glib 0.18.5` as sourced from the pinned Git commit above. Review the source patch and test Linux desktop execution before shipping. Remove the override and regenerate the lockfile when Wry/Tao/WebKitGTK no longer require GTK3's `glib 0.18`, and the selected upstream `glib` is at least `0.20.0`. Re-check this when upgrading Wry or Tao.

The [MIT license](https://github.com/gtk-rs/gtk-rs-core/blob/main/LICENSE) and upstream copyright are retained by the backport repository. The Git source is an external third-party maintenance dependency, so changes to its pinned revision require security review.
