# MesloLGS NF

The terminal's default font on every platform, so prompt and TUI icons render
without a locally installed Nerd Font. It is Meslo LG S patched with Nerd Fonts
2.3.3 icons, the build powerlevel10k recommends.

| File                      | Source                    | sha256                                                             |
| ------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `meslolgs_nf_regular.ttf` | `MesloLGS NF Regular.ttf` | `d97946186e97f8d7c0139e8983abf40a1d2d086924f2c5dbf1c29bd8f2c6e57d` |
| `meslolgs_nf_bold.ttf`    | `MesloLGS NF Bold.ttf`    | `b6c0199cf7c7483c8343ea020658925e6de0aeb318b89908152fcb4d19226003` |
| `LICENSE.txt`             | `MesloLGS NF License.txt` | `0eb25f1a4e86320ceae5f650cb75e628117c3f575bc2e332bb13cd08c3be438e` |

Source: [romkatv/powerlevel10k-media@145eb9f](https://github.com/romkatv/powerlevel10k-media/tree/145eb9fbc2f42ee408dacd9b22d8e6e0e553f83d).
Use it over the smaller `kalaschnik/meslolgs-nf-template` copy, which lacks the
Nerd Fonts v3 Material Design (`nf-md`, U+F0001+) and codicon ranges.

Only Regular and Bold ship; the terminal synthesizes italics. Native apps embed
the TTFs, which are named in lowercase with underscores because Android font
resources must be. Web and desktop load the `.woff2` files, made with:

```bash
uvx --from 'fonttools[woff]' fonttools ttLib.woff2 compress -o meslolgs-nf-regular.woff2 meslolgs_nf_regular.ttf
```

Meslo is Apache-2.0 (`LICENSE.txt`). The icon glyphs keep the licenses of their
icon sets, listed by [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts/blob/v2.3.3/LICENSE).
