[ad-hoc-daemon-testing.md](upstream/ad-hoc-daemon-testing.md).
- Find on a phone-width layout: `workspace-tab-switcher-trigger`, then
  `workspace-tab-menu-<tabId>-trigger`, then `workspace-tab-menu-<tabId>-find`. The bar is
  `pane-find-input`, `pane-find-status` (`1 of 2`), `pane-find-next`, `pane-find-previous` and
  `pane-find-close`. Wide layouts have no native Find entry point.
- Settings rows are `settings-section-<section>` and `settings-host-section-<section>`. The
  direct connection form is `direct-host-input`, `direct-port-input` and
  `direct-password-input`; Enter in the host field moves to the port, and both select their text
  on focus. Open it with `paseo://settings/general?addHost=1`, then tap `add-host-method-direct`.
  and `fork-android-update-action`, in fork builds only. The tablet guest has network, so a fork
  build there checks and downloads real releases; boot it with `CF_NET=0` for the offline error
  state. A failed background check leaves the row idle.
- To check a phone-width layout on the tablet, run `adb shell wm size 1080x2400` and
  `adb shell wm density 420`; undo with `wm size reset` and `wm density reset` before releasing the
  device.
or any wide layout) needs the scale recipe above. The phone was not measured.
Prepare a fresh local or remote QA checkout with `npm ci` at the repository root, then run
`npm run build:server` and `npm run build:daemon-web-ui` there. Do not copy or symlink another
checkout's whole `node_modules` tree into it: workspace links can resolve to the other checkout,
and missing package-local dependencies can select an incompatible root dependency. Install and
build in the QA checkout before starting its daemon or browser tests.

