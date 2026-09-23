Sources for the raster icons in `web/`. Android needs PNGs: SVG is ignored for
notification icons/badges, and a manifest without a >=144px raster icon installs
as a plain Chrome shortcut instead of a WebAPK.

```bash
rsvg-convert -w 192 -h 192 web/icon.svg -o web/icon-192.png
rsvg-convert -w 512 -h 512 web/icon.svg -o web/icon-512.png
rsvg-convert -w 512 -h 512 tools/icons/maskable.svg -o web/icon-maskable-512.png
rsvg-convert -w 180 -h 180 tools/icons/maskable.svg -o web/apple-touch-icon.png
rsvg-convert -w 96 -h 96 tools/icons/badge.svg -o web/badge-96.png
```
