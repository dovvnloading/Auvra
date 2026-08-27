# Native dependency notices

The native vertical slice pins these direct crates exactly in `Cargo.toml` and
`Cargo.lock`. Each license was verified from the official crates.io metadata,
the crate manifest, and the unpacked crate license files.

| Crate | Version | License | Official provenance |
|---|---:|---|---|
| `wgpu` | 30.0.1 | MIT OR Apache-2.0 | [crates.io](https://crates.io/crates/wgpu/30.0.1), [upstream repository](https://github.com/gfx-rs/wgpu) |
| `pollster` | 1.0.1 | Apache-2.0/MIT | [crates.io](https://crates.io/crates/pollster/1.0.1), [upstream repository](https://github.com/zesterer/pollster) |
| `serde` | 1.0.228 | MIT OR Apache-2.0 | [crates.io](https://crates.io/crates/serde/1.0.228), [upstream repository](https://github.com/serde-rs/serde) |
| `serde_json` | 1.0.145 | MIT OR Apache-2.0 | [crates.io](https://crates.io/crates/serde_json/1.0.145), [upstream repository](https://github.com/serde-rs/json) |
| `winit` | 0.30.12 | Apache-2.0 | [crates.io](https://crates.io/crates/winit/0.30.12), [upstream repository](https://github.com/rust-windowing/winit) |

The resolved transitive tree is recorded in `Cargo.lock` and is sourced from
the crates.io registry. No GPL, LGPL, or other copyleft direct dependency is
used by this native target. Redistribution must retain the applicable
MIT/Apache-2.0/Apache-2.0 notices for the complete lock tree.
