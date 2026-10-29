# MesloLGS Nerd Font

The terminal's default font on every platform, so prompt and TUI icons render
without a locally installed Nerd Font. It is Meslo LG S patched with Nerd Fonts
3.5.1 icons, in the default variant: every glyph, icons included, advances one
cell.

| File                      | Source                         | sha256                                                             |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `meslolgs_nf_regular.ttf` | `MesloLGSNerdFont-Regular.ttf` | `f3148b1e05c1dcf86785020d1d144524b9458deaab17505b88ecfe1694543214` |
| `meslolgs_nf_bold.ttf`    | `MesloLGSNerdFont-Bold.ttf`    | `63ff060fbe6db68ee719137640217f28da72fb1b78c1c41f254451f3fca1f236` |
| `LICENSE.txt`             | `LICENSE.txt`, CRLF stripped   | `0eb25f1a4e86320ceae5f650cb75e628117c3f575bc2e332bb13cd08c3be438e` |

Source: `Meslo.tar.xz` from the [Nerd Fonts v3.5.1 release](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1)
(sha256 `6b6624632dc6873dfb7681c3f818e7c01ab601ab707690b6440933bbe57e2b11`).
Don't use powerlevel10k's `MesloLGS NF`: it is patched with Nerd Fonts 2.3.3 and
lacks icons added since, such as Starship's container, sudo and AWS symbols.
Nerd Fonts 3 dropped the deprecated `nf-mdi` range (U+F500–U+FD46), so prompts
still configured with those code points need updating to `nf-md` (U+F0001+).

iOS registers the font under its internal family name, `MesloLGS Nerd Font`,
which `TERMINAL_NERD_FONT_FAMILY` must match;
`src/terminal/runtime/terminal-bundled-font-glyphs.test.ts` checks that and a
sample of post-2.3.3 icons.

Only Regular and Bold ship; the terminal synthesizes italics. Native apps embed
the TTFs, which are named in lowercase with underscores because Android font
resources must be. Web and desktop load the `.woff2` copies in
`packages/app/public/fonts/meslolgs-nf/`, made with the command below. Bump the
`?v=` query in `src/terminal/runtime/terminal-bundled-font.ts` when they change,
because files in `public/` aren't content-hashed.

```bash
uvx --from 'fonttools[woff]' fonttools ttLib.woff2 compress -o meslolgs-nf-regular.woff2 meslolgs_nf_regular.ttf
```

Meslo is Apache-2.0 (`LICENSE.txt`). The web copies ship with `LICENSE.txt` and a
`NOTICE.txt` covering the icon sets, so the web and desktop builds carry them. The icon glyphs keep the licenses of their
icon sets, listed by [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts/blob/v3.5.1/LICENSE).
