Hubwise's pixel-art icon. The art is drawn as text rows in `pixel-icon.mjs`,
which writes every icon file from it:

```bash
node tools/icons/pixel-icon.mjs
```

- `web/icon.svg`, `web/icon-192.png`, `web/icon-512.png`: the launcher icon on
  a rounded night square.
- `tools/icons/maskable.svg`, `web/icon-maskable-512.png`,
  `web/apple-touch-icon.png`: full bleed, art inside the 80% safe zone.
- `tools/icons/badge.svg`, `web/badge-96.png`: the notification badge, alpha
  only.

Android needs PNGs: SVG is ignored for notification icons/badges, and a
manifest without a >=144px raster icon installs as a plain Chrome shortcut
instead of a WebAPK. The PNGs are rasterised by the script itself with
nearest-neighbour sampling, so pixel edges stay sharp and no image tools are
needed.
